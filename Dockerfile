FROM ruby:3.2-slim

WORKDIR /app

COPY . /app

RUN ruby build_data.rb

EXPOSE 3000

CMD ["ruby", "server.rb"]
