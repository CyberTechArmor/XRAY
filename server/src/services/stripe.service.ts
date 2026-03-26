import Stripe from 'stripe';
import { withClient, withTransaction } from '../db/connection';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { getStripeConfig, getSetting } from './settings.service';
import * as auditService from './audit.service';

async function getStripeClient(): Promise<Stripe> {
  // Check platform settings first, fall back to env var
  const secretKey = await getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new AppError(500, 'STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured. Set it in Admin → Stripe or via STRIPE_SECRET_KEY env var.');
  }
  return new Stripe(secretKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
}

async function getWebhookSecret(): Promise<string> {
  const secret = await getSetting('stripe_webhook_secret') || config.stripeWebhookSecret;
  if (!secret) {
    throw new AppError(500, 'STRIPE_WEBHOOK_NOT_CONFIGURED', 'Stripe webhook secret is not configured. Set it in Admin → Stripe or via STRIPE_WEBHOOK_SECRET env var.');
  }
  return secret;
}

export async function handleWebhook(
  payload: string | Buffer,
  signature: string
): Promise<void> {
  const stripe = await getStripeClient();
  const webhookSecret = await getWebhookSecret();

  const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    case 'invoice.payment_failed':
      await handleInvoiceFailed(event.data.object as Stripe.Invoice);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    case 'payment_intent.succeeded':
      await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }
}

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  // Pricing Table checkout passes tenant_id via client_reference_id
  // Custom checkout passes it via metadata.tenant_id
  const tenantId = session.client_reference_id || session.metadata?.tenant_id;
  if (!tenantId) {
    // Try to find tenant by customer email
    const customerEmail = session.customer_email || session.customer_details?.email;
    console.error('Checkout session missing tenant_id. customer_email=' + customerEmail + ' session_id=' + session.id);
    return;
  }

  await withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

    // Update tenant with Stripe customer ID
    if (customerId) {
      await client.query(
        'UPDATE platform.tenants SET stripe_customer_id = $1, updated_at = now() WHERE id = $2',
        [customerId, tenantId]
      );
    }

    // Create or update billing state — set plan to 'starter' (active subscription)
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, stripe_subscription_id, plan_tier, payment_status, updated_at)
       VALUES ($1, $2, 'starter', 'active', now())
       ON CONFLICT (tenant_id) DO UPDATE
       SET stripe_subscription_id = COALESCE($2, platform.billing_state.stripe_subscription_id),
           plan_tier = CASE WHEN platform.billing_state.plan_tier = 'free' THEN 'starter' ELSE platform.billing_state.plan_tier END,
           payment_status = 'active', updated_at = now()`,
      [tenantId, subscriptionId || null]
    );

    auditService.log({
      tenantId,
      action: 'billing.checkout_completed',
      resourceType: 'billing',
      metadata: { session_id: session.id, customer_id: customerId, subscription_id: subscriptionId },
    });

    // Notify tenant users via WebSocket that billing changed (gate lifted)
    try {
      const { broadcastToTenant } = await import('../ws');
      broadcastToTenant(tenantId, 'billing:updated', { hasVision: true, status: 'active' });
    } catch {}
  });
}

export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tenantResult = await client.query(
      'SELECT id FROM platform.tenants WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (tenantResult.rows.length === 0) return;

    const tenantId = tenantResult.rows[0].id;

    await client.query(
      `UPDATE platform.billing_state
       SET payment_status = 'active', updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId]
    );

    auditService.log({
      tenantId,
      action: 'billing.invoice_paid',
      resourceType: 'billing',
      metadata: { invoice_id: invoice.id },
    });
  });
}

export async function handleInvoiceFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tenantResult = await client.query(
      'SELECT id FROM platform.tenants WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (tenantResult.rows.length === 0) return;

    const tenantId = tenantResult.rows[0].id;

    await client.query(
      `UPDATE platform.billing_state
       SET payment_status = 'past_due', updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId]
    );

    auditService.log({
      tenantId,
      action: 'billing.invoice_failed',
      resourceType: 'billing',
      metadata: { invoice_id: invoice.id },
    });
  });
}

export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return;

  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tenantResult = await client.query(
      'SELECT id FROM platform.tenants WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (tenantResult.rows.length === 0) return;

    const tenantId = tenantResult.rows[0].id;

    // Determine tier from subscription metadata or product
    const tier = subscription.metadata?.plan_tier || 'starter';
    const dashboardLimit = tier === 'professional' ? 50 : tier === 'starter' ? 10 : 0;
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null;

    const paymentStatus = subscription.status === 'active'
      ? 'active'
      : subscription.status === 'trialing'
        ? 'trialing'
        : subscription.status === 'past_due'
          ? 'past_due'
          : 'cancelled';

    await client.query(
      `UPDATE platform.billing_state
       SET plan_tier = $1, dashboard_limit = $2, current_period_end = $3,
           stripe_subscription_id = $4, payment_status = $5, updated_at = now()
       WHERE tenant_id = $6`,
      [tier, dashboardLimit, periodEnd, subscription.id, paymentStatus, tenantId]
    );

    auditService.log({
      tenantId,
      action: 'billing.subscription_updated',
      resourceType: 'billing',
      metadata: { subscription_id: subscription.id, tier, status: subscription.status },
    });
  });
}

export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return;

  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tenantResult = await client.query(
      'SELECT id FROM platform.tenants WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (tenantResult.rows.length === 0) return;

    const tenantId = tenantResult.rows[0].id;

    await client.query(
      `UPDATE platform.billing_state
       SET plan_tier = 'free', dashboard_limit = 0, stripe_subscription_id = NULL,
           payment_status = 'cancelled', current_period_end = NULL, updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId]
    );

    auditService.log({
      tenantId,
      action: 'billing.subscription_deleted',
      resourceType: 'billing',
      metadata: { subscription_id: subscription.id },
    });

    // Notify tenant users via WebSocket that billing changed (gate goes up)
    try {
      const { broadcastToTenant } = await import('../ws');
      broadcastToTenant(tenantId, 'billing:updated', { hasVision: false, status: 'cancelled' });
    } catch {}
  });
}

export async function handlePaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const tenantId = paymentIntent.metadata?.tenant_id;
  if (!tenantId) return;

  const resourceType = paymentIntent.metadata?.resource_type; // 'connection' or 'dashboard'
  const resourceName = paymentIntent.metadata?.resource_name;

  await withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    if (resourceType === 'connection') {
      await client.query(
        `INSERT INTO platform.connections (tenant_id, name, source_type, stripe_payment_id, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [tenantId, resourceName || 'New Connection', paymentIntent.metadata?.source_type || 'unknown', paymentIntent.id]
      );
    } else if (resourceType === 'dashboard') {
      await client.query(
        `INSERT INTO platform.dashboards (tenant_id, name, status)
         VALUES ($1, $2, 'draft')`,
        [tenantId, resourceName || 'New Dashboard']
      );
    }

    auditService.log({
      tenantId,
      action: 'billing.payment_succeeded',
      resourceType: 'billing',
      metadata: {
        payment_intent_id: paymentIntent.id,
        resource_type: resourceType,
        resource_name: resourceName,
      },
    });
  });
}

export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string
): Promise<{ url: string }> {
  const stripe = await getStripeClient();

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

export async function getBillingStatus(tenantId: string): Promise<{
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  dashboardLimit: number;
  subscriptions: Array<{
    id: string;
    productId: string;
    productName: string;
    status: string;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
  invoices: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    created: string;
    pdfUrl: string | null;
  }>;
}> {
  const billingState = await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT * FROM platform.billing_state WHERE tenant_id = $1',
      [tenantId]
    );
    return result.rows[0] || null;
  });

  const tenant = await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query('SELECT stripe_customer_id FROM platform.tenants WHERE id = $1', [tenantId]);
    return result.rows[0];
  });

  const base = {
    plan: billingState?.plan_tier || 'free',
    status: billingState?.payment_status || 'none',
    currentPeriodEnd: billingState?.current_period_end || null,
    dashboardLimit: billingState?.dashboard_limit || 0,
    subscriptions: [] as any[],
    invoices: [] as any[],
  };

  // If we have a Stripe customer, fetch live data from Stripe
  if (tenant?.stripe_customer_id) {
    try {
      const stripe = await getStripeClient();

      // Fetch active subscriptions
      const subs = await stripe.subscriptions.list({
        customer: tenant.stripe_customer_id,
        status: 'all',
        limit: 20,
        expand: ['data.items.data.price.product'],
      });

      base.subscriptions = subs.data.map((sub) => {
        const item = sub.items.data[0];
        const product = item?.price?.product;
        const productObj = typeof product === 'object' && product !== null ? product as Stripe.Product : null;
        return {
          id: sub.id,
          productId: productObj?.id || (typeof product === 'string' ? product : ''),
          productName: productObj?.name || 'Subscription',
          status: sub.status,
          quantity: item?.quantity || 1,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        };
      });

      // Fetch recent invoices
      const invs = await stripe.invoices.list({
        customer: tenant.stripe_customer_id,
        limit: 10,
      });

      base.invoices = invs.data.map((inv) => ({
        id: inv.id,
        amount: inv.amount_paid || 0,
        currency: inv.currency || 'usd',
        status: inv.status || 'unknown',
        created: new Date((inv.created || 0) * 1000).toISOString(),
        pdfUrl: inv.invoice_pdf || null,
      }));

      // Update local billing state from Stripe data
      const activeSubs = subs.data.filter((s) => s.status === 'active' || s.status === 'trialing');
      if (activeSubs.length > 0) {
        base.status = 'active';
      }
    } catch (err) {
      console.error('Failed to fetch Stripe data:', err);
      // Return local billing state if Stripe API fails
    }
  }

  return base;
}

export async function createCheckoutSession(
  tenantId: string,
  stripeCustomerId: string | null,
  items: Array<{ productId: string; quantity: number }>,
  returnUrl: string,
  customerEmail?: string
): Promise<{ url: string; sessionId: string }> {
  const stripe = await getStripeClient();

  // Resolve product prices from Stripe
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const item of items) {
    // Get the default price for each product
    const prices = await stripe.prices.list({
      product: item.productId,
      active: true,
      limit: 1,
    });
    if (prices.data.length === 0) {
      throw new AppError(400, 'NO_PRICE', `No active price found for product ${item.productId}`);
    }
    lineItems.push({
      price: prices.data[0].id,
      quantity: item.quantity,
    });
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: lineItems,
    success_url: `${returnUrl}?checkout=success`,
    cancel_url: `${returnUrl}?checkout=cancelled`,
    metadata: { tenant_id: tenantId },
    subscription_data: { metadata: { tenant_id: tenantId } },
  };

  if (stripeCustomerId) {
    params.customer = stripeCustomerId;
  } else if (customerEmail) {
    params.customer_email = customerEmail;
  }

  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url!, sessionId: session.id };
}

export { getStripeConfig };
