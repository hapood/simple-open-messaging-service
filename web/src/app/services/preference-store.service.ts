import { Injectable } from '@angular/core';
import { PreferenceStorage } from './preference-storage';
export * from './preference-storage';

/** Angular wrapper for the shared page/background preference storage. */
@Injectable({ providedIn: 'root' })
export class PreferenceStore extends PreferenceStorage {}
