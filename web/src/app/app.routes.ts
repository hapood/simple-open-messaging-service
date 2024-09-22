import { Routes } from '@angular/router';
import { LoginPageComponent } from './pages/login-page/login-page.component';
import { HomeComponent } from './pages/home/home.component';
import { PageNotFoundComponent } from './pages/page-not-found/page-not-found.component';
import { PageNavgatorComponent } from './pages/page-navgator/page-navgator.component';
import { ForbiddenPageComponent } from './pages/forbidden-page/forbidden-page.component';
import { RegisterPageComponent } from './pages/register-page/register-page.component';
export const routes: Routes = [
  { path: "", component: HomeComponent },
  { path: "nav", component: PageNavgatorComponent },
  { path: "auth/login", component: LoginPageComponent },
  { path: "auth/register", component: RegisterPageComponent },
  { path: 'forbidden', component: ForbiddenPageComponent },
  { path: '**', component: PageNotFoundComponent }
];
