import { z } from 'zod';

export const emailSchema = z.string().email().max(255).toLowerCase();
export const uuidSchema = z.string().uuid();
export const nameSchema = z.string().min(1).max(255).trim();
export const slugSchema = z.string().min(2).max(100).regex(/^[a-z0-9-]+$/);

export const signupSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  tenantName: nameSchema,
});

export const verifySchema = z.object({
  email: emailSchema,
  code: z.string().length(6).regex(/^\d{6}$/),
});

export const verifyTokenSchema = z.object({
  token: z.string().min(1),
});

export const magicLinkSchema = z.object({
  email: emailSchema,
});

export const loginBeginSchema = z.object({
  email: emailSchema,
});

export const invitationCreateSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  dashboardIds: z.array(uuidSchema).optional().default([]),
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(1),
  name: nameSchema,
});

export const userUpdateSchema = z.object({
  name: nameSchema.optional(),
  roleId: uuidSchema.optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
});

export const roleCreateSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  description: z.string().max(500).optional(),
  permissionIds: z.array(uuidSchema).optional(),
  permissions: z.array(z.string().min(1).max(100)).optional(),
});

export const roleUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().max(500).optional(),
  permissionIds: z.array(uuidSchema).optional(),
  permissions: z.array(z.string().min(1).max(100)).optional(),
});

export const dashboardCreateSchema = z.object({
  tenantId: uuidSchema,
  name: nameSchema,
  description: z.string().max(1000).optional(),
  viewHtml: z.string().max(500_000).optional(),
  viewCss: z.string().max(200_000).optional(),
  viewJs: z.string().max(500_000).optional(),
  fetchUrl: z.string().url().max(2000).optional(),
  fetchMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  fetchHeaders: z.record(z.string()).optional(),
  fetchBody: z.any().optional(),
});

export const dashboardUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().max(1000).optional(),
  viewHtml: z.string().max(500_000).optional(),
  viewCss: z.string().max(200_000).optional(),
  viewJs: z.string().max(500_000).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  fetchUrl: z.string().url().max(2000).optional().nullable(),
  fetchMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  fetchHeaders: z.record(z.string()).optional(),
  fetchBody: z.any().optional(),
});

export const connectionTemplateCreateSchema = z.object({
  name: nameSchema,
  description: z.string().max(1000).optional(),
  fetchMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  fetchUrl: z.string().max(2000).optional(),
  fetchHeaders: z.record(z.string()).optional(),
  fetchBody: z.any().optional(),
});

export const connectionCreateSchema = z.object({
  tenantId: uuidSchema,
  name: nameSchema,
  sourceType: z.enum(['api', 'csv', 'database', 'webhook']),
  sourceDetail: z.string().optional(),
  pipelineRef: z.string().optional(),
});

export const connectionUpdateSchema = z.object({
  name: nameSchema.optional(),
  status: z.enum(['pending', 'active', 'error', 'disabled']).optional(),
  pipelineRef: z.string().optional(),
});

export const connectionTableCreateSchema = z.object({
  tableName: z.string().min(1).max(255).regex(/^[a-z_][a-z0-9_]*$/),
  description: z.string().max(500).optional(),
});

export const settingsUpdateSchema = z.record(z.string().nullable());

export const emailTemplateUpdateSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
});

export const tenantCreateSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
});

export const tenantUpdateSchema = z.object({
  name: nameSchema.optional(),
});

export const dashboardAccessSchema = z.object({
  userId: uuidSchema,
});

export const embedCreateSchema = z.object({
  allowedDomains: z.array(z.string()).optional().default([]),
  expiresAt: z.string().datetime().optional(),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}) as unknown as z.ZodType<{ page: number; limit: number }>;

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().optional(),
  userId: uuidSchema.optional(),
  resourceType: z.string().optional(),
});

export const apiKeyCreateSchema = z.object({
  name: nameSchema,
  scopes: z.array(z.string().min(1)).min(1),
  tenantId: uuidSchema.optional(),
  expiresAt: z.string().datetime().optional(),
});

export const webhookCreateSchema = z.object({
  connectionId: uuidSchema,
  name: nameSchema,
  events: z.array(z.string().min(1)).optional().default(['data.push']),
});

export const webhookUpdateSchema = z.object({
  name: nameSchema.optional(),
  events: z.array(z.string().min(1)).optional(),
  isActive: z.boolean().optional(),
});

export function validateBody<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export function validateQuery<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}
