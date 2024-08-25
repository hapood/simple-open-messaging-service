import { inject } from '@angular/core';
import { CanActivateFn, UrlTree } from '@angular/router';
import { Router } from '@angular/router';

export const authGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  if (localStorage.getItem('token')) {
    return true;
  } else {
    const urlTree: UrlTree = router.parseUrl('/forbidden');
    return urlTree;
  }
};
