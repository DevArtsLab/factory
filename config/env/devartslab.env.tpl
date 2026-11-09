# DevArtsLab org — resolved at runtime by 1Password CLI.
# Vault "devartslab"; adjust item names to your vault. Real secrets never
# touch disk: run `op run --env-file=config/env/devartslab.env.tpl -- <cmd>`.
MONGODB_ORG_ID=op://devartslab/atlas/org-id
MONGODB_PROJECT_ID=op://devartslab/atlas/project-id
MONGODB_CLUSTER=op://devartslab/atlas/cluster
ATLAS_PUBLIC_API_KEY=op://devartslab/atlas/public-key
ATLAS_PRIVATE_API_KEY=op://devartslab/atlas/private-key
AGENTENGINE_WORKSPACE=op://devartslab/agentengine/workspace
OPENROUTER_API_KEY=op://devartslab/openrouter/api-key
