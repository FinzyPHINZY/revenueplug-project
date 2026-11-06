#!/bin/bash


set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:3000/callback}"

echo "🧪 Testing Stripe OAuth Flow"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}Step 1: Testing health check${NC}"
curl -s "$BASE_URL/health" | jq '.'
echo ""

echo -e "${BLUE}Step 2: Getting Stripe OAuth URL${NC}"
RESPONSE=$(curl -s -X POST "$BASE_URL/api/connections/stripe/authorize?redirect_uri=$REDIRECT_URI")
echo "$RESPONSE" | jq '.'

AUTH_URL=$(echo "$RESPONSE" | jq -r '.auth_url')
STATE=$(echo "$RESPONSE" | jq -r '.state')

echo ""
echo -e "${GREEN}✓ OAuth URL generated${NC}"
echo -e "${YELLOW}State: $STATE${NC}"
echo ""
echo "Visit this URL to authorize:"
echo -e "${BLUE}$AUTH_URL${NC}"
echo ""

echo "After authorizing on Stripe, you'll be redirected back with a code parameter."
echo "The callback handler will automatically:"
echo "  1. Exchange code for access token"
echo "  2. Encrypt and store credentials"
echo "  3. Create connection record"
echo "  4. Queue initial sync job (TODO)"
echo ""

# Test API Key flow
echo -e "${BLUE}Step 3: Testing API Key Connection (if you have a test key)${NC}"
echo "To test with API key, run:"
echo ""
echo "curl -X POST $BASE_URL/api/connections/stripe/api-key \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{"
echo "    \"account_id\": \"test_account_123\","
echo "    \"api_key\": \"sk_test_YOUR_KEY_HERE\","
echo "    \"metadata\": {}"
echo "  }'"
echo ""

echo -e "${GREEN}✓ Test script complete${NC}"
echo ""
echo "Next steps:"
echo "  1. Visit the OAuth URL above in your browser"
echo "  2. Authorize on Stripe"
echo "  3. Check the connection was created: GET $BASE_URL/api/connections/{id}"
echo "  4. Check sync status: GET $BASE_URL/api/connections/{id}/status"
