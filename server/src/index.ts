import { exitCleanlyOn, startServer } from './app';

/** Development entry point (`npm run dev`): the Vite dev server serves the UI, this serves the WebSocket. */
const running = await startServer({ port: Number(process.env.PORT ?? 4000), warmDemo: true });
console.log(`[3d-db-server] listening on ${running.url}`);
exitCleanlyOn(running);
