module.exports = {
  userId: process.env.SENCROP_USER_ID,
  organisationsIds: process.env.SENCROP_ORGANISATIONS_IDS,
  applicationId: process.env.SENCROP_APPLICATION_ID,
  applicationSecret: process.env.SENCROP_APPLICATION_SECRET,
  windcropEarlId: process.env.SENCROP_WINDCROP_EARL_ID,
  raincropEarlId: process.env.SENCROP_RAINCROP_EARL_ID,
  endPoint: process.env.SENCROP_ENDPOINT || "https://api.sencrop.com/v1",
  includeHistoryUser: process.env.SENCROP_INCLUDE_HISTORY_USER || "false",
  accessToken: "",
};
