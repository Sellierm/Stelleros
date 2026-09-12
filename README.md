# Farm React

Stelleros is a farm management web app.

It lets users:

- view forecast (OpenWeatherMap) and Sencrop weather data,
- display fields on a map,
- track GPS positions/history of machines,
- track inventory of plant protection products and interventions

## Run with Docker

The Docker image serves the built React client and the Express server from the
same container. Docker must be installed and running.

### 1. Configure the environment

Create the server environment file and fill in the required values described
below:

```powershell
Copy-Item server/.env.example server/.env
```

The `server/.env` file is not copied into the image. It is passed to the
container at runtime, so keep it out of version control.

### 2. Build the client and the image

The Dockerfile expects `client/dist` to exist before the image is built:

```powershell
npm install --prefix client
npm --prefix client run build
docker build -t farm-react .
```

### 3. Start the container

The application listens on port `3000` in this example:

```powershell
docker run --rm --name farm-react `
  --env-file server/.env `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -p 3000:3000 `
  farm-react
```

Open <http://localhost:3000>. To stop the container, press `Ctrl+C`.

After changing frontend code, run the client build and `docker build` again so
the updated `client/dist` is included in the image.

## Getting Started / Implementation

To start using this project, you need to create your own configuration files and obtain required API keys from external services.

### 1. Environment variables (`server/.env.example`)

Copy `server/.env.example` to `server/.env` and fill in the values.

What each group is used for:

- `NODE_ENV`, `PORT`, `IP`: server runtime and listening address.
- `CORS_ORIGINS`: allowed frontend origins for API calls.
- `SESSION_SECRET`: session and CSRF security secret.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`: MySQL connection.
- `GPS_INGEST_KEY`, `GPS_ALLOWED_IDS`: authorize GPS devices sending locations (should be the same in gps-sender).
- `GOOGLE_MAPS_API_KEY`: Google Maps display on the Fields page. You must generate it from the [Google Cloud Console](https://console.cloud.google.com/) (Maps JavaScript API).
- `OPENWEATHER_API_KEY`, `FORECAST_LATITUDE`, `FORECAST_LONGITUDE`, `FORECAST_CITY`: weather forecast data. Create an account on [OpenWeatherMap](https://openweathermap.org/) to get your API key.
- `SENCROP_*`: Sencrop API credentials and device identifiers. To learn how to get your Sencrop API keys, refer to their [API workflow for users](https://observablehq.com/@57ac0233e9966902/api-workflow-for-users).

### 2. Custom Maps module (`server/modules/mapModule.js`)

Create a file at `server/modules/mapModule.js` based on your [Google My Maps](https://www.google.com/maps/d/):

```javascript
module.exports = {
  key: process.env.GOOGLE_MAPS_API_KEY,
  table: [
    // Layer mapping (Year / Crop configuration mapping your KMLs)
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    // Add as many layers as needed matching your frontend logic
  ],
};
```

_Note: To extract KML links, open your custom map in Google My Maps, click on the three dots next to a layer -> "Export data" -> KML, and observe the download URL._

### 3. MySQL Database (Structure)

The project relies on a MySQL database containing the following tables. You must create them on your server:

```sql
CREATE TABLE `user` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL, -- Password hashed by bcrypt
  PRIMARY KEY (`id`)
);

CREATE TABLE `vehicles` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `type` varchar(255) DEFAULT NULL,
  `brand` varchar(255) DEFAULT NULL,
  `model` varchar(255) DEFAULT NULL,
  `year` int(4) DEFAULT NULL,
  `plate` varchar(50) DEFAULT NULL,
  `hours` float DEFAULT 0,
  PRIMARY KEY (`id`)
);

CREATE TABLE `maintenance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `vehicle_id` int(11) NOT NULL,
  `type` varchar(255) NOT NULL,
  `date` date NOT NULL,
  `hours_at_service` float DEFAULT NULL,
  `next_date` date DEFAULT NULL,
  `next_hours` float DEFAULT NULL,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON DELETE CASCADE
);

/* The following tables are required for the Phyto module */
CREATE TABLE `phyto_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `category` varchar(255) NOT NULL,
  `unit` varchar(50) NOT NULL,
  `stock` float DEFAULT 0,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `phyto_applications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `date` date NOT NULL,
  `field` varchar(255) NOT NULL,
  `quantity` float NOT NULL,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`product_id`) REFERENCES `phyto_products`(`id`) ON DELETE CASCADE
);
```

## GPS source

GPS data is sent by the **gps-sender** repository to this project's endpoint:

- Repository: [https://github.com/Sellierm/gps-sender](https://github.com/Sellierm/gps-sender)
- `POST /api/location`

## View

Actually the website looks like that :
<img width="1908" height="489" alt="image" src="https://github.com/user-attachments/assets/b579194b-b468-492b-8556-e6131bd391e8" />
<img width="1917" height="804" alt="image" src="https://github.com/user-attachments/assets/43901f6b-944d-46f5-afe6-3664ffda4713" />
<img width="1914" height="860" alt="image" src="https://github.com/user-attachments/assets/45bab89c-316a-4fd2-8896-e98b27ad9f19" />
<img width="1909" height="416" alt="image" src="https://github.com/user-attachments/assets/a8107804-f02e-479a-b7c1-f2ee4eb80915" />
