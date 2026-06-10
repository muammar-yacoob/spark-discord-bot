/**
 * Sets up a Discord server with standard community structure.
 * Usage: bun run scripts/setup-server.ts --config ./configs/viralcat.json
 */

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');

const configFlag = process.argv.indexOf('--config');
const configPath = configFlag !== -1 ? process.argv[configFlag + 1] : null;
if (!configPath) throw new Error('--config <path> required');

const config = JSON.parse(
  await Bun.file(configPath).text()
);
const GUILD_ID = config.guild_id;
const BASE = 'https://discord.com/api/v10';

async function api(
  path: string,
  method = 'GET',
  body?: any
): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || '2');
    console.log(`[rate-limit] waiting ${retry}s...`);
    await Bun.sleep(retry * 1000 + 500);
    return api(path, method, body);
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${method} ${path} -> ${res.status}: ${text}`);
    return null;
  }
  if (res.status === 204) return {};
  return res.json();
}

console.log(`\n=== Setting up ${config.app.name} (guild: ${GUILD_ID}) ===\n`);

// --- Step 1: Update server settings ---
console.log('[1/7] Updating server settings...');
await api(`/guilds/${GUILD_ID}`, 'PATCH', {
  verification_level: 1,
  default_message_notifications: 1,
  explicit_content_filter: 2,
  description: config.app.tagline,
});

// --- Step 2: Delete existing channels ---
console.log('[2/7] Clearing existing channels...');
const existingChannels = await api(`/guilds/${GUILD_ID}/channels`);
if (existingChannels) {
  for (const ch of existingChannels) {
    await api(`/channels/${ch.id}`, 'DELETE');
  }
}

// --- Step 3: Create roles ---
console.log('[3/7] Creating roles...');
const adminRole = await api(`/guilds/${GUILD_ID}/roles`, 'POST', {
  name: 'Admin', color: 15158332, hoist: true, mentionable: false, permissions: '8',
});
const modRole = await api(`/guilds/${GUILD_ID}/roles`, 'POST', {
  name: 'Moderator', color: 3447003, hoist: true, mentionable: true, permissions: '1099511627782',
});
const subRole = await api(`/guilds/${GUILD_ID}/roles`, 'POST', {
  name: 'Subscriber', color: 10181046, hoist: true, mentionable: false, permissions: '0',
});
const memberRole = await api(`/guilds/${GUILD_ID}/roles`, 'POST', {
  name: 'Member', color: 2067276, hoist: false, mentionable: false, permissions: '0',
});

if (!adminRole || !modRole || !subRole || !memberRole) {
  console.error('Failed to create roles');
  process.exit(1);
}

console.log(`  Admin: ${adminRole.id}, Mod: ${modRole.id}, Sub: ${subRole.id}, Member: ${memberRole.id}`);

// --- Step 4: Create categories and channels ---
console.log('[4/7] Creating channels...');

// Permission helpers
const everyoneId = GUILD_ID; // @everyone role ID = guild ID

function denyEveryone(channelId: string) {
  return api(`/channels/${channelId}/permissions/${everyoneId}`, 'PUT', {
    type: 0, allow: '0', deny: '3072', // deny view + send
  });
}
function allowMember(channelId: string) {
  return api(`/channels/${channelId}/permissions/${memberRole.id}`, 'PUT', {
    type: 0, allow: '68672', deny: '0', // view + send + react + history
  });
}
function readOnly(channelId: string) {
  return api(`/channels/${channelId}/permissions/${everyoneId}`, 'PUT', {
    type: 0, allow: '66560', deny: '2048', // view + history, deny send
  });
}
function staffOnly(channelId: string) {
  return Promise.all([
    api(`/channels/${channelId}/permissions/${everyoneId}`, 'PUT', {
      type: 0, allow: '0', deny: '3072',
    }),
    api(`/channels/${channelId}/permissions/${modRole.id}`, 'PUT', {
      type: 0, allow: '68672', deny: '0',
    }),
    api(`/channels/${channelId}/permissions/${adminRole.id}`, 'PUT', {
      type: 0, allow: '68672', deny: '0',
    }),
  ]);
}

// Create categories
const welcomeCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'Welcome', type: 4 });
const generalCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'General', type: 4 });
const supportCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'Support', type: 4 });
const showcaseCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'Showcase', type: 4 });
const voiceCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'Voice', type: 4 });
const staffCat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', { name: 'Staff', type: 4 });

// Lock categories
await Promise.all([
  denyEveryone(generalCat.id), allowMember(generalCat.id),
  denyEveryone(supportCat.id), allowMember(supportCat.id),
  denyEveryone(showcaseCat.id), allowMember(showcaseCat.id),
  denyEveryone(voiceCat.id), allowMember(voiceCat.id),
  staffOnly(staffCat.id),
]);

// Create channels
const rules = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'rules', type: 0, parent_id: welcomeCat.id,
  topic: 'Read and agree to participate. React with a checkmark to get access.',
});
await readOnly(rules.id);

const announcements = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'announcements', type: 0, parent_id: welcomeCat.id,
  topic: 'Official updates, releases, and news from the team.',
});
await readOnly(announcements.id);

const links = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'useful-links', type: 0, parent_id: welcomeCat.id,
  topic: 'Quick links to docs, dashboard, and more.',
});
await readOnly(links.id);

const faqCh = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'faq', type: 0, parent_id: supportCat.id,
  topic: 'Common questions answered. Search here before asking.',
});
await readOnly(faqCh.id);

const general = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'general-chat', type: 0, parent_id: generalCat.id,
  topic: 'Hang out, chat, and meet other users.', slowmode_rate_limit_per_user: 5,
});
const intros = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'introductions', type: 0, parent_id: generalCat.id,
  topic: 'New here? Say hi and tell us what you\'re building.',
  slowmode_rate_limit_per_user: 30,
});
const offTopic = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'off-topic', type: 0, parent_id: generalCat.id, topic: 'Anything goes (within reason).',
});

const help = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'help', type: 0, parent_id: supportCat.id,
  topic: 'Ask questions about setup, integration, or usage.',
});
const bugs = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'bug-reports', type: 15, parent_id: supportCat.id,
  topic: 'Found a bug? Post it here with steps to reproduce.',
});
const features = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'feature-requests', type: 15, parent_id: supportCat.id,
  topic: 'Ideas for new features or improvements.',
});

const showAndTell = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'show-and-tell', type: 0, parent_id: showcaseCat.id,
  topic: `Share what you've built with ${config.app.name}.`,
});

const lounge = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'lounge', type: 2, parent_id: voiceCat.id,
});
const cowork = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'co-working', type: 2, parent_id: voiceCat.id,
});

const modChat = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'mod-chat', type: 0, parent_id: staffCat.id, topic: 'Staff-only discussion.',
});
const botLogs = await api(`/guilds/${GUILD_ID}/channels`, 'POST', {
  name: 'bot-logs', type: 0, parent_id: staffCat.id, topic: 'Automated moderation and bot activity logs.',
});

// --- Step 5: Post rules (embed) ---
console.log('[5/7] Posting rules and welcome message...');
const brandColor = config.app.brand_color || 0x57f287;
const iconUrl = config.app.icon_url || null;
const rulesEmbed = {
  title: `Welcome to ${config.app.name}`,
  description: `${config.app.tagline}\n\nWe're glad you're here. Please read the rules below.`,
  color: brandColor,
  ...(iconUrl && { thumbnail: { url: iconUrl } }),
  fields: [
    { name: '1. Be respectful', value: 'No harassment, hate speech, or personal attacks. Ever.' },
    { name: '2. Stay on topic', value: 'Use the right channels. Off-topic has its own room.' },
    { name: '3. No spam or self-promo', value: 'Share your work in #show-and-tell, not everywhere.' },
    { name: '4. Search before asking', value: 'Check #faq and #help first.' },
    { name: '5. Report bugs properly', value: 'Use #bug-reports with steps to reproduce.' },
    { name: '6. No unsolicited DMs', value: "Don't message members or staff without permission." },
    { name: '7. English only', value: 'In public channels.' },
    { name: '8. Staff decisions are final', value: 'Disagree? DM a moderator calmly.' },
  ],
  footer: { text: 'React with a checkmark below to agree and get access.' },
};
const rulesMsg = await api(`/channels/${rules.id}/messages`, 'POST', {
  embeds: [rulesEmbed],
});

// Add checkmark reaction
if (rulesMsg) {
  await api(`/channels/${rules.id}/messages/${rulesMsg.id}/reactions/%E2%9C%85/@me`, 'PUT');
}

// Post useful links
await api(`/channels/${links.id}/messages`, 'POST', {
  content: `**${config.app.name} Quick Links**\n\n:globe_with_meridians:  **Website** -- ${config.app.url}\n:bug:  **Report a Bug** -- post in #bug-reports\n:bulb:  **Request a Feature** -- post in #feature-requests\n\n*Bookmark this channel for quick access.*`,
});

// Post FAQ (embed)
const faqEmbed = {
  title: `${config.app.name} -- FAQ`,
  color: brandColor,
  ...(iconUrl && { thumbnail: { url: iconUrl } }),
  fields: config.faq.slice(0, 25).map((f: any) => ({ name: f.q, value: f.a })),
  footer: { text: "Don't see your question? Ask in #help." },
};
const faqMsg = await api(`/channels/${faqCh.id}/messages`, 'POST', {
  embeds: [faqEmbed],
});

// Pin important messages
if (rulesMsg) await api(`/channels/${rules.id}/messages/${rulesMsg.id}/pins`, 'PUT');
if (faqMsg) await api(`/channels/${faqCh.id}/messages/${faqMsg.id}/pins`, 'PUT');

// --- Step 6: Auto-moderation ---
console.log('[6/7] Setting up auto-moderation...');
const exemptRoles = [adminRole.id, modRole.id];

await api(`/guilds/${GUILD_ID}/auto-moderation/rules`, 'POST', {
  name: 'Block spam', event_type: 1, trigger_type: 3,
  actions: [{ type: 1 }, { type: 2, metadata: { channel_id: botLogs.id } }],
  enabled: true, exempt_roles: exemptRoles,
});
await api(`/guilds/${GUILD_ID}/auto-moderation/rules`, 'POST', {
  name: 'Block invite links', event_type: 1, trigger_type: 1,
  trigger_metadata: { keyword_filter: ['discord.gg/*', 'discord.com/invite/*'] },
  actions: [{ type: 1 }, { type: 2, metadata: { channel_id: botLogs.id } }],
  enabled: true, exempt_roles: exemptRoles,
});
await api(`/guilds/${GUILD_ID}/auto-moderation/rules`, 'POST', {
  name: 'Block excessive mentions', event_type: 1, trigger_type: 5,
  trigger_metadata: { mention_total_limit: 5 },
  actions: [{ type: 1 }, { type: 2, metadata: { channel_id: botLogs.id } }],
  enabled: true, exempt_roles: exemptRoles,
});
await api(`/guilds/${GUILD_ID}/auto-moderation/rules`, 'POST', {
  name: 'Block profanity', event_type: 1, trigger_type: 4,
  trigger_metadata: { presets: [1, 2, 3] },
  actions: [{ type: 1 }, { type: 2, metadata: { channel_id: botLogs.id } }],
  enabled: true, exempt_roles: exemptRoles,
});

// --- Step 7: Update config with IDs ---
console.log('[7/7] Updating config with channel and role IDs...');
config.channels = {
  general: general.id,
  help: help.id,
  bug_reports: bugs.id,
  bot_logs: botLogs.id,
  announcements: announcements.id,
  rules: rules.id,
  faq: faqCh.id,
  links: links.id,
};
config.roles = {
  admin: adminRole.id,
  moderator: modRole.id,
  subscriber: subRole.id,
  member: memberRole.id,
};
config.rules_message_id = rulesMsg?.id || '';

await Bun.write(configPath, JSON.stringify(config, null, 2) + '\n');

// Rename bot nickname in the guild
await api(`/guilds/${GUILD_ID}/members/@me`, 'PATCH', { nick: 'Alex' });

console.log(`\n=== ${config.app.name} setup complete! ===`);
console.log(`  Channels: ${Object.keys(config.channels).length}`);
console.log(`  Roles: ${Object.keys(config.roles).length}`);
console.log(`  Rules message: ${config.rules_message_id}`);
console.log(`  Config saved to: ${configPath}\n`);
