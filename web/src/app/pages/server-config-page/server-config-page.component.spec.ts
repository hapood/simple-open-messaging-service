import { resolveOriginSelection } from './server-config-page.component';

describe('resolveOriginSelection', () => {
  it('pairs an unadvertised LAN IP with the advertised public domain', () => {
    expect(
      resolveOriginSelection(
        'http://192.168.88.208:3000',
        'https://qifa.io',
        null,
      ),
    ).toEqual({
      primary: 'https://qifa.io',
      lan: 'http://192.168.88.208:3000',
      confirmPair: true,
    });
  });

  it('retains the known-reachable address when it is outside the advertised pair', () => {
    expect(
      resolveOriginSelection(
        'http://192.168.88.208:3000/',
        'https://qifa.io',
        'https://qifa.lan',
      ),
    ).toEqual({
      primary: 'https://qifa.io',
      lan: 'http://192.168.88.208:3000',
      confirmPair: true,
    });
  });

  it('offers the advertised pair when the entered address is the public origin', () => {
    expect(
      resolveOriginSelection(
        'https://qifa.io',
        'https://qifa.io',
        'https://qifa.lan',
      ),
    ).toEqual({
      primary: 'https://qifa.io',
      lan: 'https://qifa.lan',
      confirmPair: true,
    });
  });

  it('offers the advertised pair when the entered address is the LAN origin', () => {
    expect(
      resolveOriginSelection(
        'https://qifa.lan',
        'https://qifa.io',
        'https://qifa.lan',
      ),
    ).toEqual({
      primary: 'https://qifa.io',
      lan: 'https://qifa.lan',
      confirmPair: true,
    });
  });

  it('keeps the entered address when no complete advertised pair exists', () => {
    expect(
      resolveOriginSelection('https://qifa.io/', 'https://qifa.io', null),
    ).toEqual({
      primary: 'https://qifa.io',
      lan: null,
      confirmPair: false,
    });
  });
});
