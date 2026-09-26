import {
  resolveOriginSelection,
  singleOriginAfterDecliningPair,
} from './server-config-page.component';

describe('resolveOriginSelection', () => {
  it('keeps the entered reachable address when the advertised pair is declined', () => {
    const selection = resolveOriginSelection(
      'http://127.0.0.1:3101/',
      'http://alpha.test:7667',
      null,
    );
    expect(selection).toEqual({
      primary: 'http://alpha.test:7667',
      lan: 'http://127.0.0.1:3101',
      confirmPair: true,
    });
    expect(singleOriginAfterDecliningPair('http://127.0.0.1:3101/')).toBe(
      'http://127.0.0.1:3101',
    );
  });

  it('pairs an unadvertised LAN IP with the advertised public domain', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000',
        'https://chat.example',
        null,
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'http://10.0.0.1:3000',
      confirmPair: true,
    });
  });

  it('retains the known-reachable address when it is outside the advertised pair', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000/',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'http://10.0.0.1:3000',
      confirmPair: true,
    });
  });

  it('offers the advertised pair when the entered address is the public origin', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('offers the advertised pair when the entered address is the LAN origin', () => {
    expect(
      resolveOriginSelection(
        'https://lan.chat.example',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('keeps the entered address when no complete advertised pair exists', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example/',
        'https://chat.example',
        null,
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
    });
  });
});
