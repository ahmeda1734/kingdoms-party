// Boot the KINGDOMS PARTY server.  npm start / PORT=5000 node server/index.js

import { createApp } from './app.js';

const PORT = process.env.PORT || 8080;
const { server } = createApp();
server.listen(PORT, () => {
  console.log(`KINGDOMS PARTY server running at http://localhost:${PORT}`);
});
