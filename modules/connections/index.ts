export { decryptCredentials, encryptCredentials, validateEncryptionKey } from './encryption.js';
export {
  type ConnectionWithCredentials,
  type CreateConnectionParams,
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionsByOrganization,
  updateConnectionCredentials,
  updateConnectionStatus,
  updateLastSynced,
} from './service.js';
