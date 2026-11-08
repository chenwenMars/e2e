import { expect, type App, type Screen } from 'e2e';

/** The local demo publishes admin/admin on its login page. Each attempt signs into its own tab. */
export async function login(app: App, screen: Screen) {
    await app.open('/');
    await screen.getByLabel('账号').fill('admin');
    await screen.getByLabel('密码').fill('admin');
    await screen.getByRole('button', '登录').click();
    await expect(screen.getByRole('heading', '工作首页')).toBeVisible();
}