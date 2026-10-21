# n8n credentials

The shipped workflows need **no n8n credentials**: they authenticate to the SEO Agent API with the
`x-api-key` header taken from the `SEO_API_KEY` environment variable of the n8n container.

If your n8n instance blocks `$env` access (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, the default on some hosted plans):

1. In n8n create a credential of type **Header Auth** named `SEO Agent API` with Name `x-api-key` and Value = your service key.
2. In each HTTP Request node set *Authentication → Generic credential type → Header Auth → SEO Agent API* and remove the `x-api-key` header parameter.
3. Replace `{{ $env.SEO_API_URL }}` / `{{ $env.SEO_PROJECT_ID }}` with literal values.

Never commit exported credential files – this folder is git-ignored except for this README.
