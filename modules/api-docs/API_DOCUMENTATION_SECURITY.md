# API Documentation & Security

Comprehensive guide to RevenuePlug API documentation, authentication, security, and rate limiting.

## Overview

The RevenuePlug API provides:

1. **OpenAPI/Swagger Documentation** - Interactive API documentation
2. **Multiple Authentication Methods** - JWT tokens and API keys
3. **CORS Configuration** - Secure cross-origin access
4. **Rate Limiting** - Protection against abuse
5. **Request Logging** - Correlation IDs for debugging
6. **Input Validation** - Zod schema validation on all endpoints
7. **API Key Management** - Programmatic access with scoped permissions

---

## 1. API Documentation (Swagger/OpenAPI)

### Interactive Documentation

Access interactive API documentation at:

```
http://localhost:3000/api/docs
```

**Features:**
- Try-it-out functionality for all endpoints
- Request/response schemas
- Example payloads
- Authentication testing
- Filter and search endpoints

### OpenAPI Spec

Get the raw OpenAPI specification:

```http
GET /api/docs/json
```

**Response:** OpenAPI 3.0 JSON specification

### Endpoints Summary

Get a JSON summary of all available endpoints:

```http
GET /api/endpoints
```

**Response:**
```json
{
  "version": "1.0.0",
  "total_endpoints": 85,
  "categories": [
    "authentication",
    "users",
    "organizations",
    "api_keys",
    "connections",
    "sync",
    "analytics",
    "retention",
    "settings",
    "audit_logs",
    "webhooks",
    "system"
  ],
  "endpoints": {
    "authentication": [
      {
        "method": "POST",
        "path": "/api/auth/login",
        "description": "Login with email and password",
        "auth": false
      }
    ]
  },
  "documentation": {
    "swagger": "/api/docs",
    "openapi_spec": "/api/docs/json"
  }
}
```

---

## 2. Authentication

### Method 1: JWT Tokens (Recommended for Web/Mobile Apps)

#### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your_password"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```

#### Using JWT Token

Include in Authorization header:

```http
GET /api/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Refresh Token

When access token expires (15 minutes), use refresh token:

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Method 2: API Keys (Recommended for Server-to-Server)

#### Create API Key

```http
POST /api/api-keys
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "name": "Production Server",
  "scopes": ["read:customers", "read:subscriptions", "write:campaigns"],
  "expiresInDays": 365
}
```

**Response:**
```json
{
  "id": "key_123",
  "name": "Production Server",
  "key_prefix": "rp_live_12345678",
  "scopes": ["read:customers", "read:subscriptions", "write:campaigns"],
  "enabled": true,
  "expires_at": "2025-12-30T00:00:00Z",
  "created_at": "2024-12-30T00:00:00Z",
  "secret": "rp_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "warning": "Save this API key now. You will not be able to see it again."
}
```

⚠️ **Important:** The `secret` is only shown once during creation. Store it securely!

#### Using API Key

**Option 1: X-API-Key Header (Recommended)**

```http
GET /api/customers
X-API-Key: rp_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

**Option 2: Authorization Bearer**

```http
GET /api/customers
Authorization: Bearer rp_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

### API Key Scopes

| Scope | Description | Permissions |
|-------|-------------|-------------|
| `read:customers` | Read customer data | GET /api/customers, /api/customers/:id |
| `read:subscriptions` | Read subscriptions | GET /api/subscriptions |
| `read:invoices` | Read invoices | GET /api/invoices |
| `read:campaigns` | Read campaigns | GET /api/retention/campaigns |
| `read:analytics` | Read analytics | GET /api/dashboard/*, /api/analytics/* |
| `read:settings` | Read settings | GET /api/settings |
| `write:customers` | Create/update customers | POST/PATCH /api/customers |
| `write:campaigns` | Manage campaigns | POST/PATCH/DELETE /api/retention/campaigns |
| `write:settings` | Update settings | PATCH /api/settings |
| `*` (Admin) | Full access | All endpoints |

#### Wildcard Scopes

- `read:*` - All read permissions
- `write:*` - All write permissions
- `*` - Full admin access

### Managing API Keys

#### List API Keys

```http
GET /api/api-keys
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "keys": [
    {
      "id": "key_123",
      "name": "Production Server",
      "key_prefix": "rp_live_12345678",
      "scopes": ["read:customers"],
      "enabled": true,
      "expires_at": "2025-12-30T00:00:00Z",
      "last_used_at": "2024-12-30T10:00:00Z",
      "usage_count": 1523,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### Revoke API Key

```http
DELETE /api/api-keys/:key_id
Authorization: Bearer <jwt_token>
```

---

## 3. CORS (Cross-Origin Resource Sharing)

### Allowed Origins

**Production:**
- `https://revenueplug.com`
- `https://app.revenueplug.com`
- `https://dashboard.revenueplug.com`

**Development:**
- `http://localhost:3000`
- `http://localhost:3001`
- `http://localhost:5173` (Vite)
- Any origin specified in `FRONTEND_URL` environment variable

### CORS Headers

**Allowed Methods:**
- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`

**Allowed Headers:**
- `Content-Type`
- `Authorization`
- `X-API-Key`
- `X-Request-ID`
- `X-Organization-ID`

**Exposed Headers:**
- `X-Request-ID`
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

**Credentials:**
- ✅ Enabled (cookies and authorization headers allowed)

**Preflight Cache:**
- 24 hours (86400 seconds)

### Custom Origin

Set via environment variable:

```bash
FRONTEND_URL=https://custom-domain.com
```

---

## 4. Rate Limiting

### Global Rate Limits

**Default Limit:**
- 100 requests per minute per IP/user/API key
- Redis-backed for distributed systems
- Automatically adds rate limit headers

**Rate Limit Headers:**

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
```

### Rate Limit Response

When limit exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 seconds.",
  "statusCode": 429,
  "retryAfter": 42
}
```

### Endpoint-Specific Limits

#### Authentication Endpoints

**Limit:** 5 requests per 15 minutes per IP

**Endpoints:**
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/forgot-password`

Prevents brute force attacks.

#### Webhook Endpoints

**Limit:** 1000 requests per minute per IP

**Endpoints:**
- `POST /api/webhooks/stripe`
- `POST /api/webhooks/mixpanel`
- `POST /api/webhooks/hubspot`

Higher limits for platform webhooks.

### Rate Limiting Strategy

Rate limits are applied based on:

1. **API Key** (if X-API-Key header present)
2. **User ID** (if authenticated via JWT)
3. **IP Address** (for unauthenticated requests)

### Bypassing Rate Limits

**Whitelisted IPs:**
- `127.0.0.1` (localhost)

**Fallback:** If Redis is unavailable, rate limiting is disabled to prevent blocking legitimate requests.

---

## 5. Request/Response Logging

### Correlation IDs

Every request gets a unique correlation ID for tracking:

**Request:**
```http
GET /api/customers
X-Request-ID: 550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```http
HTTP/1.1 200 OK
X-Request-ID: 550e8400-e29b-41d4-a716-446655440000
```

If `X-Request-ID` header is provided, it will be used. Otherwise, a UUID is generated.

### Log Format

**Request Logs:**
```json
{
  "level": "info",
  "time": "2024-12-30T10:00:00Z",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "method": "GET",
  "url": "/api/customers",
  "ip": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "headers": {
    "authorization": "[REDACTED]",
    "x-api-key": "[REDACTED]"
  },
  "query": {},
  "msg": "Request started"
}
```

**Response Logs:**
```json
{
  "level": "info",
  "time": "2024-12-30T10:00:01Z",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "method": "GET",
  "url": "/api/customers",
  "statusCode": 200,
  "responseTime": "125.43ms",
  "msg": "Request completed"
}
```

### Slow Request Logging

Requests taking > 1 second are logged as warnings:

```json
{
  "level": "warn",
  "time": "2024-12-30T10:00:02Z",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "method": "GET",
  "url": "/api/analytics/trends",
  "responseTime": "1523.67ms",
  "userId": "user_123",
  "organizationId": "org_456",
  "msg": "Slow request detected"
}
```

### Sanitized Headers

Sensitive headers are redacted in logs:

- `authorization` → `[REDACTED]`
- `cookie` → `[REDACTED]`
- `x-api-key` → `[REDACTED]`
- `x-webhook-signature` → `[REDACTED]`

---

## 6. Input Validation

### Zod Schema Validation

All endpoints use Zod schemas for request validation:

**Example:**

```typescript
const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(100),
  trigger_type: z.enum(['CHURN_RISK_HIGH', 'PAYMENT_FAILURE']),
  cooldown_days: z.number().min(1).max(90),
  actions: z.array(z.object({
    type: z.enum(['EMAIL', 'DISCOUNT', 'PERSONAL_OUTREACH']),
    delay_minutes: z.number().min(0),
  })),
});
```

**Validation Error Response:**

```http
HTTP/1.1 400 Bad Request

{
  "error": "Validation Error",
  "message": "Invalid request body",
  "issues": [
    {
      "path": ["name"],
      "message": "String must contain at least 1 character(s)"
    },
    {
      "path": ["cooldown_days"],
      "message": "Number must be less than or equal to 90"
    }
  ]
}
```

### Sanitization

- **SQL Injection:** Prevented by Prisma ORM (parameterized queries)
- **XSS:** HTML content sanitized before storage
- **Path Traversal:** File paths validated
- **Email Validation:** RFC 5322 compliant
- **URL Validation:** Valid URL format required

---

## 7. Security Best Practices

### API Key Security

✅ **DO:**
- Store API keys in environment variables
- Use separate keys for dev/staging/production
- Rotate keys every 90 days
- Use minimum required scopes
- Revoke unused keys

❌ **DON'T:**
- Commit keys to version control
- Share keys across teams
- Use same key for multiple environments
- Grant `*` (admin) scope unless necessary
- Log API keys (they're auto-redacted)

### JWT Token Security

✅ **DO:**
- Store access tokens in memory (not localStorage)
- Store refresh tokens in HttpOnly cookies
- Implement token refresh flow
- Validate tokens on every request
- Use short expiration times (15 minutes for access tokens)

❌ **DON'T:**
- Store tokens in localStorage (XSS risk)
- Send tokens in URL query parameters
- Share tokens between users
- Use same secret for all environments

### HTTPS

⚠️ **Production Requirement:**

All API communication MUST use HTTPS in production.

```bash
# Enforce HTTPS (production only)
if (process.env.NODE_ENV === 'production') {
  app.addHook('onRequest', (request, reply, done) => {
    if (!request.headers['x-forwarded-proto']?.includes('https')) {
      reply.code(400).send({ error: 'HTTPS required' });
      return;
    }
    done();
  });
}
```

### Webhook Security

**Verify Signatures:**

All incoming webhooks verify HMAC-SHA256 signatures:

```typescript
import { timingSafeEqual } from 'node:crypto';

const isValid = timingSafeEqual(
  Buffer.from(expectedSignature, 'hex'),
  Buffer.from(receivedSignature, 'hex')
);
```

**Outgoing Webhooks:**

Include signature in `X-Webhook-Signature` header:

```typescript
const signature = crypto
  .createHmac('sha256', secret)
  .update(JSON.stringify(payload))
  .digest('hex');
```

---

## 8. Error Responses

### Standard Error Format

```json
{
  "error": "Error Type",
  "message": "Human-readable error message",
  "statusCode": 400
}
```

### HTTP Status Codes

| Code | Meaning | When Used |
|------|---------|-----------|
| 200 | OK | Successful GET request |
| 201 | Created | Successful POST (resource created) |
| 204 | No Content | Successful DELETE |
| 400 | Bad Request | Invalid request body/parameters |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Authenticated but lacks permissions |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource already exists |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server error |
| 503 | Service Unavailable | Temporary unavailability |

### Error Examples

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "message": "API key required",
  "statusCode": 401
}
```

**403 Forbidden:**
```json
{
  "error": "Forbidden",
  "message": "This operation requires the 'write:campaigns' scope",
  "statusCode": 403
}
```

**404 Not Found:**
```json
{
  "error": "Not Found",
  "message": "Campaign not found",
  "statusCode": 404
}
```

**429 Rate Limited:**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 seconds.",
  "statusCode": 429,
  "retryAfter": 42
}
```

---

## 9. API Versioning

### Current Version

**v1.0.0**

### Future Versioning Strategy

When breaking changes are introduced:

1. New version prefix: `/api/v2/...`
2. Old version deprecated: `/api/v1/...` (maintained for 6 months)
3. Migration guide provided
4. Deprecation warnings in response headers

**Example:**
```http
GET /api/v2/customers
```

---

## 10. Testing the API

### Using cURL

**Login:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "your_password"
  }'
```

**Authenticated Request:**
```bash
curl http://localhost:3000/api/users/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**API Key Request:**
```bash
curl http://localhost:3000/api/customers \
  -H "X-API-Key: rp_live_1234567890abcdef..."
```

### Using Postman

1. Import OpenAPI spec: `http://localhost:3000/api/docs/json`
2. Set up environment variables:
   - `BASE_URL`: `http://localhost:3000`
   - `ACCESS_TOKEN`: `<your_jwt_token>`
   - `API_KEY`: `<your_api_key>`
3. Use `{{BASE_URL}}` in requests
4. Add `Authorization: Bearer {{ACCESS_TOKEN}}` header

### Using JavaScript/TypeScript

```typescript
// Using fetch
const response = await fetch('http://localhost:3000/api/customers', {
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});

const customers = await response.json();
```

```typescript
// Using API key
const response = await fetch('http://localhost:3000/api/customers', {
  headers: {
    'X-API-Key': process.env.REVENUEPLUG_API_KEY,
  },
});
```

---

## 11. Troubleshooting

### Issue: CORS Error

**Symptom:**
```
Access to fetch at 'http://localhost:3000/api/customers' from origin 'http://localhost:5173'
has been blocked by CORS policy
```

**Solution:**
1. Add origin to `FRONTEND_URL` environment variable
2. Verify credentials are enabled in frontend request
3. Check preflight OPTIONS request succeeds

### Issue: 401 Unauthorized

**Symptom:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired API key"
}
```

**Solution:**
1. Verify API key is correct
2. Check API key hasn't been revoked
3. Verify API key hasn't expired
4. Ensure key is sent in correct header

### Issue: 429 Too Many Requests

**Symptom:**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

**Solution:**
1. Wait for rate limit reset (check `Retry-After` header)
2. Implement exponential backoff
3. Use API keys instead of IP-based limits
4. Contact support for higher limits if needed

### Issue: Slow Requests

**Symptom:**
Response times > 1 second

**Solution:**
1. Check correlation ID in logs
2. Review slow request logs
3. Optimize query parameters (pagination, filtering)
4. Use caching where appropriate
5. Check database indexes

---

## 12. Migration Guide

### From No Auth to JWT

**Before:**
```typescript
fetch('/api/customers')
```

**After:**
```typescript
fetch('/api/customers', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
})
```

### From JWT to API Keys

**Before:**
```typescript
// Login to get token
const loginResponse = await fetch('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password })
});
const { access_token } = await loginResponse.json();

// Use token
fetch('/api/customers', {
  headers: { 'Authorization': `Bearer ${access_token}` }
});
```

**After:**
```typescript
// Create API key once (via UI or authenticated request)
// Store in environment variable

// Use API key
fetch('/api/customers', {
  headers: { 'X-API-Key': process.env.REVENUEPLUG_API_KEY }
});
```

---

## 13. Performance Optimization

### Pagination

Always use pagination for list endpoints:

```http
GET /api/customers?limit=50&offset=0
```

### Field Selection (Future)

Request only needed fields:

```http
GET /api/customers?fields=id,email,name
```

### Caching

Cache responses using ETags:

```http
GET /api/customers
If-None-Match: "abc123"

HTTP/1.1 304 Not Modified
```

### Compression

Responses are gzip compressed automatically.

---

## Environment Variables

```bash
# API Configuration
NODE_ENV=production
PORT=3000

# CORS
FRONTEND_URL=https://app.revenueplug.com

# Rate Limiting
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-jwt-secret-key
JWT_REFRESH_SECRET=your-refresh-secret-key
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Logging
LOG_LEVEL=info
```

---

**Total Endpoints:** 85+
**Authentication Methods:** 2 (JWT, API Keys)
**Rate Limit:** 100 req/min (global), 5 req/15min (auth)
**Documentation:** Interactive Swagger UI + JSON spec

---

**Documentation Version:** 1.0
**Last Updated:** 2024-12-30
