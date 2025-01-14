/**
 * A module that exports an AmqpClient client
 * which inherits from the SpaceBunny base client
 * @module AmqpClient
 */

// Import some helpers modules
import merge from 'merge';
import Promise from 'bluebird';
import when from 'when';
import _ from 'lodash';

// Import amqplib
import amqp from 'amqplib';

// Import SpaceBunny main module from which AmqpClient inherits
import SpaceBunny from '../spacebunny';
import AmqpMessage from '../messages/amqpMessage';
const CONFIG = require('../../config/constants').CONFIG;

class AmqpClient extends SpaceBunny {

  /**
   * @constructor
   * @param {Object} opts - options must contain Device-Key or connection options
   * (deviceId and secret) for devices.
   */
  constructor(opts) {
    super(opts);
    this._amqpConnection = undefined;
    this._amqpChannels = {};
    const amqpOptions = CONFIG.amqp;
    this._protocol = amqpOptions.protocol;
    this._sslProtocol = amqpOptions.ssl.protocol;
    this._inputQueueArgs = amqpOptions.inputQueueArgs;
    this._deviceExchangeArgs = amqpOptions.deviceExchangeArgs;
    this._subscribeArgs = amqpOptions.subscribeArgs;
    this._publishArgs = amqpOptions.publishArgs;
    this._socketOptions = amqpOptions.socketOptions;
  }

  /**
   * Subscribe to input channel
   *
   * @param {function} callback - function called every time a message is received
   * passing the current message as argument
   * @param {Object} options - subscription options
   * @return promise containing the result of the subscription
   */
  onReceive(callback, opts) {
    opts = merge(this._subscribeArgs, opts);
    opts.noAck = (opts.ack === null);
    // Receive messages from imput queue
    return new Promise((resolve, reject) => {
      this._createChannel('input', opts).then((ch) => {
        return when.all([
          ch.checkQueue(`${this.deviceId()}.${this._inboxTopic}`, this._inputQueueArgs),
          ch.consume(`${this.deviceId()}.${this._inboxTopic}`, (message) => {
            // Create message object
            const amqpMessage = new AmqpMessage(message, this._deviceId, opts);
            const ackNeeded = this._autoAck(opts.ack);
            // Check if should be accepted or not
            if (amqpMessage.blackListed()) {
              if (ackNeeded) { ch.nack(message, opts.allUpTo, opts.requeue); }
              return;
            }
            // Call message callback
            callback(this._parseContent(amqpMessage.content), amqpMessage.fields, amqpMessage.properties);
            // Check if ACK is needed
            if (ackNeeded) { ch.ack(message, opts.allUpTo); }
          }, opts)
        ]);
      }).then((res) => {
        resolve(res);
      }).catch((reason) => {
        reject(reason);
      });
    });
  }

  /**
   * Publish a message on a specific channel
   *
   * @param {String} channel - channel name on which you want to publish a message
   * @param {Object} message - the message payload
   * @param {Object} opts - publication options
   * @return promise containing the result of the subscription
   */
  publish(channel, message, opts = {}) {
    opts = merge(this._publishArgs, opts);
    return new Promise((resolve, reject) => {
      this._createChannel('output', opts).then((ch) => {
        const bufferedMessage = new Buffer(this._encapsulateContent(message));
        const promises = [
          ch.checkExchange(this.deviceId()),
          ch.publish(this.deviceId(), this._routingKeyFor(channel), bufferedMessage, opts)
        ];
        if (opts.withConfirm === true) {
          promises.push(ch.waitForConfirms());
        }
        return when.all(promises);
      }).then((res) => {
        resolve(res);
      }).catch((reason) => {
        reject(reason);
      });
    });
  }

  /**
   * Destroy the connection between the amqp client and broker
   *
   * @return a promise containing the result of the operation
   */
  disconnect() {
    return new Promise((resolve, reject) => {
      if (this._amqpConnection === undefined) {
        reject('Not Connected');
      } else {
        this._amqpConnection.close().then(() => {
          this._amqpConnection = undefined;
          resolve(true);
        }).catch((reason) => {
          reject(reason);
        });
      }
    });
  }

  // ------------ PRIVATE METHODS -------------------

  /**
   * Establish an amqp connection with the broker
   * using configurations retrieved from the endpoint.
   * If the connnection already exists, returns the current connnection
   *
   * @private
   * @return a promise containing current connection
   */
  _connect() {
    let connectionOpts = merge({}, this._socketOptions);

    return new Promise((resolve, reject) => {
      this.getEndpointConfigs().then((endpointConfigs) => {
        const connectionParams = endpointConfigs.connection;
        if (this._amqpConnection !== undefined) {
          resolve(this._amqpConnection);
        } else {
          // TODO if ssl change connections string and connection parameters
          let connectionString = '';
          if (this._ssl) {
            connectionString = `${this._sslProtocol}://${connectionParams.deviceId || connectionParams.client}:` +
              `${connectionParams.secret}@${connectionParams.host}:` +
              `${connectionParams.protocols.amqp.sslPort}/${connectionParams.vhost.replace('/', '%2f')}`;
            connectionOpts = merge(connectionOpts, this._sslOpts);
          } else {
            connectionString = `${this._protocol}://${connectionParams.deviceId || connectionParams.client}:` +
              `${connectionParams.secret}@${connectionParams.host}:` +
              `${connectionParams.protocols.amqp.port}/${connectionParams.vhost.replace('/', '%2f')}`;
          }
          amqp.connect(connectionString, connectionOpts).then((conn) => {
            conn.on('error', (err) => {
              reject(err);
            });
            conn.on('blocked', (reason) => {
              console.warn(reason); // eslint-disable-line no-console
            });
            conn.on('unblocked', (reason) => {
              console.warn(reason); // eslint-disable-line no-console
            });
            this._amqpConnection = conn;
            resolve(this._amqpConnection);
          }).catch((reason) => {
            reject(reason);
          });
        }
      }).catch((reason) => {
        reject(reason);
      });
    });
  }

  /**
   * Creates a channel on current connection
   *
   * @private
   * @param {String} channelName - indicates the channel name
   * @param {Object} opts - channel options
   * @return a promise containing the current channel
   */
  _createChannel(channelName, opts = {}) {
    channelName = `${channelName}${(opts.withConfirm === true) ? 'WithConfirm' : ''}`;
    return new Promise((resolve, reject) => {
      if (this._amqpChannels[channelName]) {
        resolve(this._amqpChannels[channelName]);
      } else {
        this._connect().then((conn) => {
          if (opts.withConfirm === true) {
            return conn.createConfirmChannel();
          } else {
            return conn.createChannel();
          }
        }).then((ch) => {
          this._amqpChannels[channelName] = ch;
          resolve(ch);
        }).catch((reason) => {
          reject(reason);
        });
      }
    });
  }

  /**
   * Close a channel on current connection
   *
   * @private
   * @param {String} channelName - indicates if the channel is input or output
   * @return a promise containing the result of the operation
   */
  _closeChannel(channelName, opts = {}) {
    channelName = `${channelName}${(opts.withConfirm === true) ? 'WithConfirm' : ''}`;
    return new Promise((resolve, reject) => {
      const ch = this._amqpChannels[channelName];
      if (ch === undefined) {
        reject('Invalid Channel Object');
      } else {
        ch.close().then(() => {
          this._amqpChannels[channelName] = undefined;
          resolve(true);
        }).catch((reason) => {
          reject(reason);
        });
      }
    });
  }

  /**
   * Generate the routing key for a specific channel
   *
   * @private
   * @param {String} channel - channel name on which you want to publish a message
   * @return a string that represents the routing key for that channel
   */
  _routingKeyFor(channel) {
    return `${this.deviceId()}.${channel}`;
  }

  /**
   * Check if the SDK have to automatically ack messages
   *
   * @private
   * @param {String} ack - the ack type, it should be 'manual' or 'auto'
   * @return boolean - true if messages have to be autoacked, false otherwise
   */
  _autoAck(ack) {
    if (ack) {
      if (!_.includes(CONFIG[this._protocol].ackTypes, ack)) {
        console.error('Wrong acknowledge type'); // eslint-disable-line no-console
      }
      switch (ack) {
        case 'auto':
          return true;
        default:
          return false;
      }
    }
    return true;
  }

}

export default AmqpClient;
