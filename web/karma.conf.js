// Karma config for headless runs. Chrome 145 needs --headless=new (the built-in
// ChromeHeadless launcher's legacy --headless no longer loads pages) and this
// host needs --no-sandbox. The Angular builder framework/plugin must be declared
// so the compiled test bundle is served and executed.
module.exports = (config) => {
  config.set({
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('@angular-devkit/build-angular/plugins/karma'),
    ],
    browsers: ['ChromeHeadlessNew'],
    customLaunchers: {
      ChromeHeadlessNew: {
        base: 'Chrome',
        flags: [
          '--headless=new',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--remote-debugging-port=9223', // 9222 is taken by adb on this host (Android dev) → Chrome can't bind its debugging port → karma "not captured"
          '--no-proxy-server',
          '--password-store=basic', // Linux: Chrome otherwise tries to unlock the GNOME keyring (Secret Service) on startup → GUI password prompt blocks the headless process → "not captured". No-op on macOS/Windows.
        ],
      },
    },
    singleRun: true,
    restartOnFileChange: false,
  });
};
