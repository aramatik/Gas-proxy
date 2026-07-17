# Используем легковесный образ Node.js 20
FROM node:20-alpine

# Устанавливаем системную утилиту zip, python3 pip curl bash mc и vsftpd
RUN apk add --no-cache zip python3 py3-pip curl bash mc vsftpd

# Устанавливаем временные инструменты сборки, необходимые для компиляции крипто-библиотек Python
RUN apk add --no-cache --virtual .build-deps gcc musl-dev libffi-dev python3-dev

# Создаем директорию приложения
WORKDIR /usr/src/app

# Копируем package.json и устанавливаем Node.js зависимости
COPY package*.json ./
RUN npm install --production

# Устанавливаем необходимые Python библиотеки через pip
RUN pip install --no-cache-dir --break-system-packages \
    requests \
    base58 \
    coincurve \
    pycryptodome

# Удаляем инструменты сборки после компиляции Python-пакетов
RUN apk del .build-deps

# ---------------------------------------------------
# ИНТЕГРАЦИЯ FTP-СЕРВЕРА
# ---------------------------------------------------

# Создаем пользователя ftpuser (без пароля на этапе сборки) и настраиваем конфиг
RUN adduser -D ftpuser && \
    mkdir -p /home/ftpuser/files && \
    chown -R ftpuser:ftpuser /home/ftpuser && \
    echo "anonymous_enable=NO" > /etc/vsftpd.conf && \
    echo "local_enable=YES" >> /etc/vsftpd.conf && \
    echo "write_enable=YES" >> /etc/vsftpd.conf && \
    echo "local_umask=022" >> /etc/vsftpd.conf && \
    echo "listen=YES" >> /etc/vsftpd.conf && \
    echo "listen_ipv6=NO" >> /etc/vsftpd.conf && \
    echo "seccomp_sandbox=NO" >> /etc/vsftpd.conf && \
    echo "pasv_enable=YES" >> /etc/vsftpd.conf && \
    echo "pasv_min_port=40000" >> /etc/vsftpd.conf && \
    echo "pasv_max_port=40050" >> /etc/vsftpd.conf

# Создаем стартовый скрипт
# Он возьмет пароль из переменной $FTP_PASSWORD (или поставит 'defaultpass', если переменная пуста)
RUN echo "#!/bin/bash" > /start.sh && \
    echo 'echo "ftpuser:${FTP_PASSWORD:-defaultpass}" | chpasswd' >> /start.sh && \
    echo "vsftpd /etc/vsftpd.conf &" >> /start.sh && \
    echo "exec npm start" >> /start.sh && \
    chmod +x /start.sh

# ---------------------------------------------------

# Копируем исходный код
COPY . .

# Порты (8080: Node.js, 21+40000-40050: FTP)
EXPOSE 8080 21 40000-40050

# Запускаем контейнер через подготовленный скрипт
CMD [ "/start.sh" ]
