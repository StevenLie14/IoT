process.env.MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

module.exports = {
  flowFile: 'flows.json',
  flowFilePretty: true,
  credentialSecret: false,
};
