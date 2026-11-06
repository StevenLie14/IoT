const crypto = require('crypto');

// Config connect ke MQTT
process.env.MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

const username = process.env.DASHBOARD_USER || 'admin';
const password = process.env.DASHBOARD_PASSWORD || '';

function sameText(first, second) {
  const firstBuffer = Buffer.from(String(first));
  const secondBuffer = Buffer.from(String(second));
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

// Login dashboard
function authorized(header) {
  if (!password) return true;
  if (!header || !header.startsWith('Basic ')) return false;
  const [name, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');


  return sameText(name, username) && sameText(rest.join(':'), password); 
}

// Middleware
function basicAuth(request, response, next) {
  if (!authorized(request.headers.authorization)) {
    response.set('WWW-Authenticate', 'Basic realm="IoT Water Quality"');
    return response.status(401).send('Login required');
  }
  next();
}

module.exports = {
  uiPort: Number(process.env.PORT) || 1880,
  userDir: '/app/data',
  flowFile: '/app/flows.json',
  flowFilePretty: true,
  credentialSecret: false,
  httpAdminRoot: false,
  httpStatic: '/app/static',
  dashboard: {
    middleware: basicAuth,
    ioMiddleware(socket, next) {
      if (authorized(socket.request.headers.authorization)) return next();
      next(new Error('Login required'));
    },
  },
  logging: { console: { level: 'info', metrics: false, audit: false } },
};
