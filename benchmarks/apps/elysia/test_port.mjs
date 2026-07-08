import { Elysia } from 'elysia';

const app = new Elysia();
const server = app.listen({ port: 0 });

console.log('Server type:', typeof server);
console.log('Server keys:', Object.keys(server || {}));
console.log('Server:', server);

if (server.server) {
  console.log('Server.server:', server.server);
  console.log('Address:', server.server.address?.());
}

process.exit(0);
