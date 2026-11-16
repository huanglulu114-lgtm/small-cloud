// This is a dedicated, user-authorized read-only memory page identifier.
// It is not a credential and grants no Notion access without NOTION_TOKEN.
const DEFAULT_MEMORY_PAGE_ID = "419a76bf-b8ff-8104-b562-dc107bed7d4c";

export function notionMemoryPageIds(env) {
  // Explicit production configuration wins. The fallback avoids asking the
  // user to type a lengthy identifier after granting access to this page.
  const raw = String(env.NOTION_MEMORY_PAGE_IDS || "").trim() || DEFAULT_MEMORY_PAGE_ID;
  return raw.split(",").map(value => value.trim())
    .filter(value => /^[a-f0-9-]{32,36}$/i.test(value)).slice(0, 4);
}


// Read the canonical Cloudflare secret; also support the original lowercase
// name used in the first setup so users do not have to recreate credentials.
// No secret value is ever returned to the browser or committed to GitHub.
export function notionToken(env) {
  return env.NOTION_TOKEN || env.notion || env.NOTION || "";
}

// Redeploy production Pages Functions after the Notion secret was saved.
