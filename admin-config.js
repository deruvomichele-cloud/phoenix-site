/*
 * Public runtime configuration only. Never place secrets in this file.
 * Real admin authorization must be enforced by the backend for every request.
 */
window.PHOENIX_ADMIN_API_URL = /(^localhost$|\.fly\.dev$)/.test(window.location.hostname)
  ? window.location.origin
  : '';
window.PHOENIX_ADMIN_WALLETS = [];
window.PHOENIX_ASH_ADDRESS = '0xd4FbB5E4Dd24C3F9A0F58Efa656A489D24E93BCd';
window.PHOENIX_POOL_ADDRESS = '0xE5104018379973BA5a65b82bC7E876b766357de6';
window.PHOENIX_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
window.PHOENIX_CHAIN_ID = '0x2105';
