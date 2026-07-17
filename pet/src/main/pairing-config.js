function isCompletePairing(config) {
  return !!String(config?.serverUrl || '').trim()
    && !!String(config?.roomSecret || '').trim()
    && ['a', 'b'].includes(config?.memberId)
    && !!String(config?.deviceId || '').trim()
    && !!String(config?.deviceName || '').trim();
}

function shouldShowControlOnStartup(config) {
  return !isCompletePairing(config);
}

module.exports = { isCompletePairing, shouldShowControlOnStartup };
