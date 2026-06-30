# Static landing page (didmarc.dev). Build context: this directory.
FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/index.html
# Fly health checks hit "/"; nginx's default server serves it.
EXPOSE 80
