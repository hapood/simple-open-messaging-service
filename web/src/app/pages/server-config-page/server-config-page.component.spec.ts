import { resolveOriginSelection } from './server-config-page.component';

describe('resolveOriginSelection', () => {
  it('does not invent a backup from an unadvertised entered address', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000/',
        'https://chat.example',
        null,
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
    });
  });

  it('uses the server-advertised backup even when entered through another address', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000/',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('keeps one address when the server advertises identical origins', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example',
        'https://chat.example/',
        'https://chat.example/',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
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
