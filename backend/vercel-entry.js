// Vercel entry for the "backend" service: the admin/staff API (no live game). The live game runs
// on the event-day laptop (game-server.js); this API reaches it at the admin-configured
// "game server address" using GAME_LINK_SECRET.
const { createApp, remoteHooks } = require('./app');

module.exports = createApp(remoteHooks());
