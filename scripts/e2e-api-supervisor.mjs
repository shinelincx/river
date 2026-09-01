import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';

if (process.env.RIVER_PRODUCTION_E2E !== '1') throw new Error('The API restart supervisor is only available to the production PostgreSQL E2E suite');

const apiUrl = `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/me`;
const controlPort = Number(process.env.RIVER_E2E_CONTROL_PORT ?? 3101);
let apiProcess;
let stopping = false;

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (apiProcess?.exitCode !== null) throw new Error(`Production API exited before becoming ready (${apiProcess?.exitCode})`);
    try {
      const response = await fetch(apiUrl);
      if (response.status < 500) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Production API did not become ready');
}

async function startApi() {
  apiProcess = spawn(process.execPath, ['apps/api/dist/index.js'], {
    env: process.env,
    stdio: 'inherit'
  });
  await waitForApi();
}

async function stopApi() {
  const processToStop = apiProcess;
  if (!processToStop || processToStop.exitCode !== null) return;
  const exited = new Promise((resolve) => processToStop.once('exit', resolve));
  processToStop.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (processToStop.exitCode === null) {
    processToStop.kill('SIGKILL');
    await exited;
  }
}

let restartQueue = Promise.resolve();
const controlServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/restart') {
    response.writeHead(404).end();
    return;
  }
  try {
    restartQueue = restartQueue.then(async () => {
      await stopApi();
      await startApi();
    });
    await restartQueue;
    response.writeHead(204).end();
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end(error instanceof Error ? error.message : 'restart failed');
  }
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  controlServer.close();
  await stopApi();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await startApi();
controlServer.listen(controlPort, '127.0.0.1');
