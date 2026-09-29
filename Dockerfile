FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css sw.js manifest.webmanifest /usr/share/nginx/html/
COPY js /usr/share/nginx/html/js
COPY icons /usr/share/nginx/html/icons
EXPOSE 80
