export function getStealthScript(): string {
  return `
    // 1. Webdriver evasion
    try {
      if (navigator.webdriver !== undefined) {
        const proto = Object.getPrototypeOf(navigator);
        const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
        if (desc) {
          Object.defineProperty(proto, 'webdriver', {
            ...desc,
            get: () => undefined
          });
        }
      }
    } catch(e) {}
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. User-Agent and AppVersion Evasion
    const customUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
    try {
      Object.defineProperty(navigator, 'userAgent', { get: () => customUA });
      Object.defineProperty(navigator, 'appVersion', { get: () => customUA.replace('Mozilla/', '') });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    } catch(e) {}

    // 3. User-Agent Client Hints Evasion
    try {
      const userAgentData = {
        brands: [
          { brand: 'Not/A)Brand', version: '99' },
          { brand: 'Google Chrome', version: '137' },
          { brand: 'Chromium', version: '137' }
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async (hints) => {
          return {
            brands: [
              { brand: 'Not/A)Brand', version: '99.0.0.0' },
              { brand: 'Google Chrome', version: '137.0.0.0' },
              { brand: 'Chromium', version: '137.0.0.0' }
            ],
            mobile: false,
            platform: 'Windows',
            platformVersion: '15.0.0', // Windows 11
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: '137.0.0.0',
            fullVersionList: [
              { brand: 'Not/A)Brand', version: '99.0.0.0' },
              { brand: 'Google Chrome', version: '137.0.0.0' },
              { brand: 'Chromium', version: '137.0.0.0' }
            ]
          };
        }
      };
      Object.defineProperty(navigator, 'userAgentData', { get: () => userAgentData });
    } catch(e) {}

    // 4. Standard Browser Props
    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en'],
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    // 5. Headless Dimensions Evasion (avoid outerWidth/outerHeight being 0)
    try {
      if (window.outerWidth === 0 || window.outerHeight === 0) {
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
      }
    } catch(e) {}

    // 6. Chrome API mocking
    window.chrome = {
      runtime: { onConnect: {}, onMessage: {} },
      loadTimes: function() { return {}; },
      csi: function() { return {}; },
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
    };

    // 7. Notification Permission query override
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
        : originalQuery(parameters);

    // 8. WebGL Spoofing (Vendor & Renderer)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.apply(this, arguments);
      };
    }

    // 9. WebGL readPixels noise injection to prevent WebGL fingerprinting
    const _readPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
      _readPixels.apply(this, arguments);
      if (pixels) {
        for (let i = 0; i < pixels.length; i++) {
          if (Math.random() < 0.03) {
            pixels[i] = Math.min(255, Math.max(0, pixels[i] + (Math.random() > 0.5 ? 1 : -1)));
          }
        }
      }
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const _readPixels2 = WebGL2RenderingContext.prototype.readPixels;
      WebGL2RenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
        _readPixels2.apply(this, arguments);
        if (pixels) {
          for (let i = 0; i < pixels.length; i++) {
            if (Math.random() < 0.03) {
              pixels[i] = Math.min(255, Math.max(0, pixels[i] + (Math.random() > 0.5 ? 1 : -1)));
            }
          }
        }
      };
    }

    // 10. Connection mock
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });

    // 11. Plugins & MimeTypes Evasion
    (function() {
      function makeMime(desc, suffixes, type) {
        const m = { description: desc, suffixes: suffixes, type: type };
        return m;
      }
      const pdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
      const pdfxMime = makeMime('Portable Document Format', 'pdf', 'text/pdf');
      const pdfPlugin = {
        name: 'PDF Viewer',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer',
        length: 2,
        0: pdfMime,
        1: pdfxMime,
      };
      pdfMime.enabledPlugin = pdfPlugin;
      pdfxMime.enabledPlugin = pdfPlugin;

      const chromePdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
      const chromePdfMime2 = makeMime('Portable Document Format', 'pdf', 'text/pdf');
      const chromePdfPlugin = {
        name: 'Chrome PDF Viewer',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer',
        length: 2,
        0: chromePdfMime,
        1: chromePdfMime2,
      };
      chromePdfMime.enabledPlugin = chromePdfPlugin;
      chromePdfMime2.enabledPlugin = chromePdfPlugin;

      const nativePlugin = {
        name: 'Native Client',
        description: '',
        filename: 'internal-nacl-plugin',
        length: 2,
        0: makeMime('Native Client Executable', '', 'application/x-nacl'),
        1: makeMime('Portable Native Client Executable', '', 'application/x-pnacl'),
      };
      nativePlugin[0].enabledPlugin = nativePlugin;
      nativePlugin[1].enabledPlugin = nativePlugin;

      const pluginsList = [pdfPlugin, chromePdfPlugin, nativePlugin];
      const mimeList = [pdfMime, pdfxMime, chromePdfMime, chromePdfMime2, nativePlugin[0], nativePlugin[1]];

      function makeNamedNodeMap(items, namedEntries) {
        const arr = [...items];
        for (const [k, v] of namedEntries) arr[k] = v;
        arr.item = function(i) { return this[i] || null; };
        arr.namedItem = function(name) { return this[name] || null; };
        arr.refresh = function() {};
        return arr;
      }

      const pluginEntries = pluginsList.map((p, i) => [p.name, p]);
      const mimeEntries = mimeList.map((m) => [m.type, m]);

      const pluginsArr = makeNamedNodeMap(pluginsList, pluginEntries);
      const mimeArr = makeNamedNodeMap(mimeList, mimeEntries);

      Object.defineProperty(navigator, 'plugins', { get: () => pluginsArr });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArr });
    })();

    // 12. Advanced Canvas Fingerprinting Evasion
    (function() {
      const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      const _toBlob = HTMLCanvasElement.prototype.toBlob;
      const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

      function addNoise(canvas) {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const style = ctx.fillStyle;
          // Very slight noise fill
          ctx.fillStyle = 'rgba(255,255,255,0.01)';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = style;
        } catch(e) {}
      }

      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        addNoise(this);
        return _toDataURL.apply(this, args);
      };
      HTMLCanvasElement.prototype.toBlob = function(...args) {
        addNoise(this);
        return _toBlob.apply(this, args);
      };

      // Add noise to getImageData to break Canvas hash verification scripts
      CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
        const imageData = _getImageData.apply(this, arguments);
        const data = imageData.data;
        // Subtle pixel manipulation
        for (let i = 0; i < data.length; i += 4) {
          if (Math.random() < 0.05) {
            data[i] = Math.min(255, Math.max(0, data[i] + (Math.random() > 0.5 ? 1 : -1)));
            data[i+1] = Math.min(255, Math.max(0, data[i+1] + (Math.random() > 0.5 ? 1 : -1)));
            data[i+2] = Math.min(255, Math.max(0, data[i+2] + (Math.random() > 0.5 ? 1 : -1)));
          }
        }
        return imageData;
      };
    })();

    // 13. Audio Fingerprinting Evasion
    (function() {
      if (typeof OfflineAudioContext === 'undefined') return;
      const _startRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return _startRendering.apply(this, arguments).then(buffer => {
          try {
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
              const data = buffer.getChannelData(ch);
              for (let i = 0; i < Math.min(data.length, 100); i++) {
                data[i] += (Math.random() - 0.5) * 1e-7;
              }
            }
          } catch(e) {}
          return buffer;
        });
      };
    })();
  `;
}
