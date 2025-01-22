FROM python:3.13

# Install Debian packages
RUN <<EOT
    apt-get update
    apt-get -y install git
    apt-get -y clean
EOT

# Install Python requirements
COPY requirements.txt /tmp/requirements.txt
RUN <<EOT
    pip install --no-cache-dir -U pip
    pip install --no-cache-dir -r /tmp/requirements.txt
    rm /tmp/requirements.txt
EOT

# Create the workspace folder
RUN mkdir /workspace

# Run the server
EXPOSE 5000
CMD ["flask", "--app", "backend.app", "--debug", "run", "--host=0.0.0.0"]
