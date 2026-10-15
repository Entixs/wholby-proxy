Example files for running Wholby Proxy behind nginx on Linux.

  wholby-proxy.service      systemd service. Change "youruser" and the folder to match yours.
  nginx-http-context.conf   goes in /etc/nginx/conf.d/ (login rate limit and a log format that hides tokens)
  nginx-site.conf           the site itself. Change emby.example.com to your domain and the certificate lines
                            to your own (for example the ones certbot creates).

The main README has the same setup as copy-and-paste steps.
