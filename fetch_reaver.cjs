const https = require("https");

https
  .get("https://valorant-api.com/v1/weapons/skins", (resp) => {
    let data = "";

    resp.on("data", (chunk) => {
      data += chunk;
    });

    resp.on("end", () => {
      const json = JSON.parse(data);
      const reaver = json.data.find((s) => s.displayName === "Reaver Sheriff" || s.displayName === "Yağmacı Sheriff");
      const standard = json.data.find((s) => s.uuid === "1ef6ba68-4dbe-30c7-6bc8-93a6c6f13f04");

      console.log("Reaver Sheriff:", reaver ? reaver.uuid : "Not Found");
      if (reaver) console.log("Reaver Display Icon:", reaver.displayIcon);

      console.log("Standard Sheriff:", standard ? standard.displayName : "Not Found");
      console.log("Standard UUID:", "1ef6ba68-4dbe-30c7-6bc8-93a6c6f13f04");
    });
  })
  .on("error", (err) => {
    console.log("Error: " + err.message);
  });
