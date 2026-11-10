Example files for running Wholby Proxy behind nginx on Linux.

  wholby-proxy.service      systemd service. Change "youruser" and the folder to match yours.
  nginx-http-context.conf   goes in /etc/nginx/conf.d/ (login rate limit and a log format that hides tokens)
  nginx-site.conf           the site itself. Change emby.example.com to your domain and the certificate lines
                            to your own (for example the ones certbot creates).

The main README has the same setup as copy-and-paste steps.

Behind Cloudflare?
  Login limits (nginx and the dashboard's own) are counted per client address. Behind Cloudflare, nginx only sees
  Cloudflare's addresses unless you restore the real one: add a conf.d file with
      set_real_ip_from <each range from https://www.cloudflare.com/ips/>;
      real_ip_header CF-Connecting-IP;
  Without it, every visitor shares one limit.
