// -----------------------------------------------------------------------------
// Entry point of the Xiaomi Home integration for Gladys Assistant.
//
// This file only wires the SDK callbacks to the manager (src/deviceManager.js),
// which owns the Xiaomi session, the device catalog and the traffic in both
// directions.
//
// Environment variables injected by the Gladys supervisor:
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// The SDK reads them itself: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { XiaomiHomeManager, redirectUrlFor } from './src/deviceManager.js';
import {
  buildAuthorizeUrl,
  authState,
  exchangeCode,
  parseAuthorizationInput,
} from './src/xiaomi/oauth.js';
import { AUTH_KEYS, generateInstanceId, readInstanceId } from './src/config.js';

const gladys = new GladysIntegration();
const manager = new XiaomiHomeManager(gladys);

/** Make sure the installation has its stable id (created once, then reused). */
async function ensureInstanceId() {
  if (manager.instanceId) {
    return manager.instanceId;
  }
  const config = await gladys.getConfig();
  const existing = readInstanceId(config);
  if (existing) {
    manager.instanceId = existing;
    return existing;
  }
  const instanceId = generateInstanceId();
  await gladys.setConfig({ [AUTH_KEYS.instanceId]: instanceId });
  manager.instanceId = instanceId;
  return instanceId;
}

/** Publish the catalog: devices, then their transport badge. */
async function publishCatalog() {
  await gladys.publishDiscoveredDevices(manager.buildDiscoveredDevices());
  const transports = manager.buildTransportEntries();
  if (transports.length > 0) {
    await gladys.publishTransports(transports);
  }
}

// --- Account linking ----------------------------------------------------------
// Xiaomi validates the OAuth `redirect_uri` against the one registered for its
// client id and accepts NOTHING but `http(s)://homeassistant.local:8123/...`
// ("invalid redirect uri" otherwise), so a Gladys address can never be the
// redirect target. The browser is therefore taken out of the loop: "Connect"
// opens a QR code, the user approves it from their phone, and the integration
// collects the authorization code server-side (src/xiaomi/qrLogin.js).

/** Finish a linking that just succeeded: publish, subscribe, read. */
async function afterLink(count) {
  await publishCatalog();
  manager.startPush();
  await gladys.setConnectionStatus(true);
  await manager.pollAll();
  logger.info(`Xiaomi account linked, ${count} devices published`);
}

gladys.onOAuthAuthorizeUrl(async () => {
  await ensureInstanceId();
  const { qrImageUrl, completion } = await manager.beginQrLogin();
  // The user now scans the QR; the link finishes on its own.
  completion.then(afterLink).catch(async (err) => {
    logger.error(`QR sign-in failed: ${err.message}`);
    await gladys
      .setConnectionStatus(false, {
        en: `Xiaomi sign-in failed: ${err.message}`,
        fr: `Échec de la connexion Xiaomi : ${err.message}`,
      })
      .catch(() => {});
  });
  return qrImageUrl;
});

// Fallback for a user who cannot scan the QR: this action hands out the
// classic sign-in URL, and `login` takes back the address it lands on.
gladys.onAction('manual_login', async () => {
  const instanceId = await ensureInstanceId();
  const url = buildAuthorizeUrl({ instanceId, redirectUrl: redirectUrlFor(instanceId) });
  return {
    en: `Open this URL, sign in, then copy the address you land on into "Finish the login": ${url}`,
    fr: `Ouvrez cette URL, identifiez-vous, puis copiez l'adresse obtenue dans « Terminer la connexion » : ${url}`,
  };
});

gladys.onAction('login', async (fields) => {
  const instanceId = await ensureInstanceId();
  const { code, state } = parseAuthorizationInput(fields.code);
  if (state && state !== authState(instanceId)) {
    throw new Error('the pasted address does not match this Gladys installation (state mismatch)');
  }
  const auth = await exchangeCode({
    cloudServer: manager.config.cloud_server,
    instanceId,
    redirectUrl: redirectUrlFor(instanceId),
    code,
  });
  await manager.useAuth(auth);
  const count = await manager.loadDevices();
  await afterLink(count);
  return {
    en: `Xiaomi account linked: ${count} devices found. Add them from the Discovery tab.`,
    fr: `Compte Xiaomi connecté : ${count} appareils trouvés. Ajoutez-les depuis l'onglet Découverte.`,
  };
});

gladys.onAction('refresh_devices', async () => {
  const count = await manager.loadDevices();
  await publishCatalog();
  manager.startPush();
  return {
    en: `${count} devices refreshed from the Xiaomi cloud.`,
    fr: `${count} appareils rafraîchis depuis le cloud Xiaomi.`,
  };
});

gladys.onAction('sign_out', async () => {
  manager.stop();
  manager.auth = null;
  await gladys.setConfig({
    [AUTH_KEYS.accessToken]: '',
    [AUTH_KEYS.refreshToken]: '',
    [AUTH_KEYS.expiresTs]: 0,
  });
  await gladys.setConnectionStatus(false, {
    en: 'Xiaomi account disconnected.',
    fr: 'Compte Xiaomi déconnecté.',
  });
  return {
    en: 'Xiaomi account disconnected. Use "Connect" to link it again.',
    fr: 'Compte Xiaomi déconnecté. Utilisez « Connecter » pour le relier à nouveau.',
  };
});

// --- Discovery, commands, polling ----------------------------------------------

gladys.onScanRequest(async () => {
  if (!manager.linked) {
    logger.warn('scan requested but no Xiaomi account is linked');
    return;
  }
  await manager.loadDevices();
  await publishCatalog();
  manager.startPush();
});

gladys.onSetValue(async (device, feature, value) => {
  await manager.setValue(device, feature, value);
});

gladys.onPoll(async (device) => {
  if (!manager.linked) {
    return;
  }
  await manager.poll(device);
});

// --- Configuration --------------------------------------------------------------

gladys.onConfigUpdated(async (newConfig) => {
  const previousRegion = manager.config.cloud_server;
  manager.applyConfig(newConfig);
  if (!manager.linked) {
    return;
  }
  if (previousRegion !== manager.config.cloud_server) {
    logger.info(`region changed to ${manager.config.cloud_server}, reloading the catalog`);
  }
  await manager.loadDevices();
  await publishCatalog();
  manager.startPush();
});

// --- Connection lifecycle ---------------------------------------------------------

gladys.on('connected', async () => {
  try {
    manager.applyConfig(await gladys.getConfig());
    if (!manager.linked) {
      logger.info('no Xiaomi account linked yet: open the Configuration screen and click Connect');
      await gladys.setConnectionStatus(false, {
        en: 'Connect your Xiaomi account from the Configuration screen.',
        fr: 'Connectez votre compte Xiaomi depuis l’écran de configuration.',
      });
      return;
    }
    manager.scheduleRefresh();
    await manager.loadDevices();
    await publishCatalog();
    manager.startPush();
    await gladys.setConnectionStatus(true);
    // First read: the push channel only carries CHANGES.
    await manager.pollAll();
  } catch (err) {
    logger.error('initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: `Could not reach the Xiaomi cloud: ${err.message}`,
        fr: `Impossible de joindre le cloud Xiaomi : ${err.message}`,
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  manager.stopClients();
});

// --- Graceful shutdown -------------------------------------------------------------

gladys.handleShutdown((signal) => {
  logger.info(`received ${signal} -> graceful shutdown`);
  manager.stop();
});

// --- Startup -------------------------------------------------------------------------

logger.info('starting the Xiaomi Home integration...');
gladys.connect().catch((err) => {
  logger.error('initial connection failed', err);
  process.exit(1);
});
