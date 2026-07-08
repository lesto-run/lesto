import { Elysia } from 'elysia';
import { realisticBody, simulateDbLatency } from '../_contract.mjs';

const app = new Elysia()
  .get('/realistic', async ({ set }) => {
    await simulateDbLatency();
    set.headers['content-type'] = 'text/html';
    return realisticBody();
  });

const server = app.listen({ port: 0 });

await new Promise(resolve => setTimeout(resolve, 50));

try {
  const port = server.server.port;
  const res = await fetch('http://127.0.0.1:' + port + '/realistic');
  console.log('Content-Type:', res.headers.get('content-type'));
  const body = await res.text();
  const expected = realisticBody();
  console.log('Match:', body === expected);
  console.log('Body length:', body.length, 'Expected:', expected.length);
} finally {
  server.stop();
}
