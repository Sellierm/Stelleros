module.exports = {
  key: process.env.OPENWEATHER_API_KEY,
  latitude: Number(process.env.FORECAST_LATITUDE),
  longitude: Number(process.env.FORECAST_LONGITUDE),
  city: process.env.FORECAST_CITY,
};
