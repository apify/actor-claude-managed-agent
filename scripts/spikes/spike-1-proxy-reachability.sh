#!/usr/bin/env bash
#
# Spike 1: Can the Apify MCP Proxy be reached from outside the Apify network
# with an Apify token (acting as the credential the Anthropic agent runtime
# would inject from a vault)?
#
# Sends a minimal MCP `initialize` request to the connector's path on the
# proxy and dumps the raw HTTP response.
#
# Usage:
#   APIFY_MCP_PROXY_URL=https://<host> \
#   APIFY_TOKEN=apify_api_... \
#   CONNECTOR_ID=conn_xxx \
#     ./spike-1-proxy-reachability.sh
#
# See ./README.md for how to interpret the result.

set -euo pipefail

: "${APIFY_MCP_PROXY_URL:?need APIFY_MCP_PROXY_URL}"
: "${APIFY_TOKEN:?need APIFY_TOKEN}"
: "${CONNECTOR_ID:?need CONNECTOR_ID (e.g. conn_abc123)}"

URL="${APIFY_MCP_PROXY_URL%/}/connection/${CONNECTOR_ID}"

echo "POST ${URL}"
echo "Authorization: Bearer ${APIFY_TOKEN:0:8}…"
echo

curl -sS -i -X POST "${URL}" \
  -H "Authorization: Bearer ${APIFY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "apify-spike", "version": "0.0.1" }
    }
  }'

echo
echo
echo "Interpret:"
echo "  200 + MCP response  -> proxy reachable from outside (Option A is alive)"
echo "  401                  -> token rejected"
echo "  403                  -> connector not authorized for this token's owner / run"
echo "  4xx/5xx other        -> investigate"
