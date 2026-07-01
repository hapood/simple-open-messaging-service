import { Routes } from '@angular/router';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { HomeComponent } from './pages/home/home.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
import { ChatboxPlaygroundComponent } from './pages/chatbox-playground/chatbox-playground.component';
import { authGuard, guestGuard } from './auth.guard';
export const routes: Routes = [
  { path: "", component: HomeComponent, canActivate: [authGuard] },
  { path: "nav", component: PageNavgatorComponent, canActivate: [authGuard] },
  { path: "auth/login", component: LoginPageComponent, canActivate: [guestGuard] },
  { path: "auth/register", component: RegisterPageComponent, canActivate: [guestGuard] },
  { path: 'forbidden', component: ForbiddenPageComponent },
  { path: 'playground/chatbox-a', component: ChatboxPlaygroundComponent, data: { useNativeAnchor: true } },
  { path: 'playground/chatbox-b', component: ChatboxPlaygroundComponent },
  { path: '**', component: PageNotFoundComponent }
];
