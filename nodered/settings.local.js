process.env.MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
process.env.MQTT_USER = process.env.MQTT_USER || '';
process.env.MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

module.exports = {
  flowFile: 'flows.json',
  flowFilePretty: true,
  credentialSecret: false,
};
