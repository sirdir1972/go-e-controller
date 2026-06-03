# ioBroker go-eCharger Virtual Controller & Surplus Charging

This repository contains an ioBroker JavaScript solution to control a go-eCharger (hardware V3/V4) via its local API v2. It acts as a "Virtual Controller," sending real-time grid, solar, and battery data to the wallbox, enabling native surplus charging and displaying the energy flow graph directly in the go-e app.

## Features
* **Virtual Controller:** Continuously pushes power data (Grid, PV, Battery) to the wallbox to satisfy the native eco-charging logic and app visualizations.
* **Surplus Charging (Eco Mode):** Toggles the charger's automated surplus charging logic.
* **Instant Charging:** Quickly override eco-settings for full-power charging, while backing up and restoring your previous limits.
* **Night Charging Scheduler:** Automatically triggers instant charging during specific night hours (e.g., 00:00 - 08:00) when energy tariffs might be cheaper.
* **Vehicle Profile Switch (Zoe / Standard):** Includes a toggle to handle EVs with sensitive charging electronics (like the Renault Zoe). It automatically adjusts the minimum charging current (`mca`) and simulates cable unplugging (`su`) to wake up the car after a charging pause, preventing vehicle errors.

## Prerequisites
* **ioBroker** with the **JavaScript (ioBroker.javascript)** adapter installed.
* **go-eCharger** connected to your local network.
* **go-e API v2** enabled (can be activated via the go-e smartphone app under Settings -> API).
* Data points for your smart meter, solar generation, and battery storage available in ioBroker.

## Installation & Setup
1. Create a new JavaScript within your ioBroker `Scripts` tab.
2. Copy the contents of `go-e_controller.js` into the script.
3. Modify the `ConfigData` object at the very top of the script with your local IP and specific ioBroker data points (see configuration section).
4. Start the script. It will automatically generate all necessary states under `0_userdata.0.go-e.`.

## Configuration Parameters

You need to replace the placeholder values in the `ConfigData` object with your actual data:

* `goeIP`: The local IP address of your go-eCharger.
* `smartMeterDP`: ioBroker state ID for grid power. Expects Watts (Integer). Positive = Grid draw, Negative = Feed-in.
* `pvDP`: ioBroker state ID for solar power. Expects Watts (Integer). Positive = Generating.
* `batteryDP`: ioBroker state ID for battery power. Expects Watts (Integer). Positive = Discharging into house, Negative = Charging battery.
