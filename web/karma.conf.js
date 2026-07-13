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
          '--remote-debugging-port=9222',
          '--no-proxy-server',
        ],
      },
    },
    singleRun: true,
    restartOnFileChange: false,
  });
};
