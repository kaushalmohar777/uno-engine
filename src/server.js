// Process entry point: wires config, the HTTP API (src/api), and the
// realtime socket server (src/realtime) together.
import express from 'express';
import { createServer } from 'node:http';
import config from './config/index.js';
import healthRoutes from './api/health.routes.js';
import sessionsRoutes from './api/sessions.routes.js';
import { createSocketServer } from './realtime/socketServer.js';

const app = express();
app.use(express.json());

app.use(healthRoutes);
app.use(sessionsRoutes);

const httpServer = createServer(app);
createSocketServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(`uno-engine listening on port ${config.port}`);
});

export default httpServer;
