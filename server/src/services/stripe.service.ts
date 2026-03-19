import Stripe from 'stripe';
import { withClient, withTransaction } from '../db/connection';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { getStripeConfig } from './settings.service';
import * as auditService from './audit.service';

function getStripeClient(): Stripe {
  // Use the secret key from env (not the publishable key from settings)
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new AppError(500, 'STRIPE_NOT_CONFIGURED', 'Stripe is not configured');
  }
  return new Stripe(secretKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
}

export async function handleWebhook(
  payload: string | Buffer,
  signature: string
): Promise<void> {
  const stripe = getStripeClient();

  if (!config.stripeWebhookSecret) {
    throw new AppError(500, 'STRIPE_WEBHOOK_NOT_CONFIGURED', 'Stripe webhook secret is not configured');
  }

  const event = stripe.webhooks.constructEvent(payload, signature, config.stripeWebhookSecret);

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
  const tenantId = session.metadata?.tenant_id;
  if (!tenantId) {
    console.error('Checkout session missing tenant_id metadata');
    return;
  }

  await withTransaction(async (client) => {
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

    // Update tenant with Stripe customer ID
    if (customerId) {
      await client.query(
        'UPDATE platform.tenants SET stripe_customer_id = $1, updated_at = now() WHERE id = $2',
        [customerId, tenantId]
      );
    }

    // Create or update billing state
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, stripe_subscription_id, payment_status, updated_at)
       VALUES ($1, $2, 'active', now())
       ON CONFLICT (tenant_id) DO UPDATE
       SET stripe_subscription_id = $2, payment_status = 'active', updated_at = now()`,
      [tenantId, subscriptionId || null]
    );

    auditService.log({
      tenantId,
      action: 'billing.checkout_completed',
      resourceType: 'billing',
      metadata: { session_id: session.id, customer_id: customerId },
    });
  });
}

export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  await withClient(async (client) => {
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
  const stripe = getStripeClient();

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

export { getStripeConfig };
