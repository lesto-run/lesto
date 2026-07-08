import Fastify from 'fastify';
import { ssrBody, realisticBody, simulateDbLatency } from '../_contract.mjs';

const app = Fastify({ logger: false });
const SSR_BODY = ssrBody();

// Test /ssr pattern (no return)
app.get("/ssr-test", (_req, reply) => reply.type("text/html").send(SSR_BODY));

// Test /realistic pattern (with return)
app.get("/realistic-test", async (_req, reply) => {
  await simulateDbLatency();
  return reply.type("text/html").send(realisticBody());
});

app.listen({ port: 0, host: '127.0.0.1' }, async (err, address) => {
  if (err) throw err;
  
  const port = address.split(':')[2];
  
  try {
    const r1 = await fetch('http://127.0.0.1:' + port + '/ssr-test');
    const b1 = await r1.text();
    
    const r2 = await fetch('http://127.0.0.1:' + port + '/realistic-test');
    const b2 = await r2.text();
    
    console.log('SSR route status:', r1.status, 'length:', b1.length);
    console.log('Realistic route status:', r2.status, 'length:', b2.length);
    console.log('Realistic body matches expected:', b2 === realisticBody());
  } finally {
    app.close();
  }
});
