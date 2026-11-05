const crypto = require('crypto');

process.env.MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

const user = process.env.DASHBOARD_USER || 'admin';
const pass = process.env.DASHBOARD_PASSWORD || '';

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(header) {
  if (!pass) return true;
  if (!header || !header.startsWith('Basic ')) return false;
  const [name, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return sameText(name, user) && sameText(rest.join(':'), pass);
}

function basicAuth(req, res, next) {
  if (!authorized(req.headers.authorization)) {
    res.set('WWW-Authenticate', 'Basic realm="IoT Water Quality"');
    return res.status(401).send('Login required');
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
