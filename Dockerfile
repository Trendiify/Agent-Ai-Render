FROM node:20-bookworm-slim

# پایتون + کتابخانه‌های پرکاربرد برای ساخت فایل (Excel/Word/PowerPoint/PDF/نمودار)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages \
      openpyxl python-docx python-pptx pandas pillow requests beautifulsoup4 reportlab matplotlib pypdf pypdfium2

# اجرا با کاربر عادی (نه root)
RUN useradd -m -u 10001 runner
WORKDIR /app
COPY server.js extract.py render_page.py ./
USER runner

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
