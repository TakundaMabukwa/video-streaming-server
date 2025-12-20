H5 Page-V2
【Recommend 】LiveV2 H5 page usage instructions document
1. Page overview
Provides an independent live broadcast window, which can be embedded into the required page through iframe. The parameters in the link can be used to control the live media server node, stream type, whether to display node information, whether to display imei information, etc.
2. Access address
https://www.mettaxiot.com/h5/#/live/v2?deviceId=711062605855&channelId=1&token=Web_uyZ9ryD8vjSY9MDbZdZYRuk7vsnUhBuv3Zv5Z7JcVcBspcA7Ap2Y9bO1xEs5EzGVzE9pnJIZ3VH48Se3QxiXSyjogVZ1qRNEa9cv&v=2&bitStream=1&streaming=singapore-1&showTop=true&showBottom=true&decoder=wcs&countdownMinutes=10
3. Parameter description
Parameter Name	Type	Required/Optional	Optional Value	Default Value	Description
deviceId	String	Required	—	—	Device ID (deviceId): The number that uniquely identifies the device. Used to specify the device to which the video stream to be queried belongs.
channelId	String	Required	1-16	—	Channel Number (channelId): The channel number that identifies the video stream. Used to specify the specific channel of the video stream to be queried.
token	String	Required	—	—	Authentication token, used to verify user permissions. By providing a valid token, ensure that only authorized users can access the page.
bitStream	Number	Optional	0/1	1	Stream type; 0 is the main stream; 1 is the sub-stream.
streaming	String	Optional	singapore-1/singapore-2/southAfrica-1/uae-1/india-1/eU-1, etc.	singapore-1	Live streaming media; for specific optional values, please refer to the liveNodes data obtained by the getNodes interface in openApi. Use the nodeValue in it to select live streaming media.
showTop	boolean	Optional	true/false	true	Whether to disable the display at the top, which displays the current live streaming type and bitstream type.
showBottom	boolean	optional	true/false	true	Whether to disable the display below, the display content is imei-ch.
decoder	String	optional	wasm/mse/wcs	wasm	Decoding method;Default wasm:wasm mode playback;mse:Open MediaSource hard decoding;wcs:Open Webcodecs hard decoding
countdownMinutes	Number	optional	-	-	Live countdown reminder, in minutes. Positive integers can be filled in. No reminder will be set if left blank.
4. Instructions for use
1.
Enter the provided address into your browser.
2.
Enter the parameters according to the page prompts. Make sure the parameters contain the correct device ID and channel number, as well as the token parameter.
3.
Click the query button or press the Enter key, and the page will display the device data within the specified time period.
4.
The page will display the real-time video stream of the specified channel of the specified device. Users can watch the real-time operation of the device.
5. Precautions
Please make sure that the Device ID and Channel Number in the parameters are correct, otherwise the video stream may not be queried correctly or incorrect results may be displayed.
Do not disclose the token parameters to others, otherwise it may allow unauthorized users to access the page or obtain sensitive information.
Page loading and data query may take some time, please be patient.
If you encounter other problems, please contact technical support for assistance.
Modified at 17 days ago
Previous
H5 page
Next
README


live video
-- -- -- -- 
liveVideo
POST
/v2/openapi/video/live
9.26 Added parameter nodeValue, optional live streaming node
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
start with 1
>= 1
bitstreamType
integer  | 
null 
optional
Video stream 0: Main stream 1: Sub-stream Default main stream
nodeValue
string  | 
null 
optional
The name of the streaming server for the live stream or the default one if it is not passed The value of this parameter can be obtained through the /v2/audio/nodes interface
Example
{
    "deviceId": "61",
    "channelId": 3607291325289637,
    "bitstreamType": 27,
    "nodeValue": null
}
Request Code Samples
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
string  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": "",
  "msg": ""
}
Modified at 2 days ago


liveVideoControl
POST
/v2/openapi/video/live/control
Live broadcast control
Stream switching
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
bitstreamType
integer  | 
null 
required
Switch stream type
0: Main stream 1: Sub stream
>= 0
<= 1
Example
{
    "deviceId": "240070417261",
    "channelId": 1,
    "bitstreamType": 1
}
Request Code Samples
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {},
  "msg": ""
}
Modified at 2 days ago
Previous
liveVideo
Next
getNodes




IotHub

Ctrl+K
README
Update Record
createToken
POST
destroyToken
POST
customerPage
POST
customerTree
POST
devicePage
POST
deviceTypes
POST
deviceTypeInfo
POST
deviceDataByDeviceIds
POST
deviceDataByCustomerId
POST
deviceTripInfoByTripId
POST
deviceTripsByDeviceId
POST
deviceTraffic
POST
deviceSensorData
POST
expandInfoByDeviceId
POST
saveDeviceChannelName
POST
fencePage
POST
fenceInfo
POST
addFence
POST
saveFence
POST
delFence
POST
fenceDevices
POST
fenceDeviceUpdate
POST
fenceDeviceDel
POST
fenceDeviceAdd
POST
README
filePageV2
POST
filePage
POST
deleteFile
POST
capture
POST
capturePage
POST
captureRecord
POST
faceRecordPage
POST
rfidPage
POST
Protocol Analysis
POST
history
playBackList
POST
/v2/openapi/video/history/list
fileUrl is empty, indicating that no historical videos have been uploaded. You can upload device history videos through "/v2/openapp/video/history/upload". You can view all upload records through "/v2/openapi/video/history/upload/task".

Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
>= 1
startTime
string  | 
null 
required
startTime Device Time Zone yyyy-MM-dd HH:mm:ss
endTime
string  | 
null 
required
endTime Device Time Zone yyyy-MM-dd HH:mm:ss
Example
{
  "deviceId": "240070417261",
  "channelId": 1,
  "startTime": "2025-12-11 00:00:00",
  "endTime": "2025-12-11 23:59:59"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiVideoHistoryVO)]  | 
null 
optional
deviceName
string  | 
null 
optional
deviceName
channelId
integer  | 
null 
optional
channelId
fileSize
number  | 
null 
optional
fileSize unit(MB)
startTime
string  | 
null 
optional
startTime yyyy-MM-dd HH:mm:ss Device Time Zone
endTime
string  | 
null 
optional
endTime yyyy-MM-dd HH:mm:ss Device Time Zone
fileUrl
string  | 
null 
optional
file download path
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "deviceName": "",
      "channelId": 0,
      "fileSize": 0.0,
      "startTime": "",
      "endTime": "",
      "fileUrl": ""
    }
  ],
  "msg": ""
}
Modified at 2 days ago
Previous
README
Next
historicalUpload
Built with


DevicePage

devicePage
POST
/v2/openapi/device/page
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
pageSize
integer  | 
null 
optional
pageSize,default 100,can't change
Default:
100
pageIndex
integer  | 
null 
required
Default:
1
customerId
string  | 
null 
optional
deviceIds
string  | 
null 
optional
Multiple devices should be separated by a comma
deviceName
string  | 
null 
optional
deviceType
string  | 
null 
optional
activeTimeStart
string  | 
null 
optional
yyyy-MM-dd HH:mm:ss UTC = 0
activeTimeEnd
string  | 
null 
optional
yyyy-MM-dd HH:mm:ss UTC = 0
subsumption
boolean  | 
null 
required
Include Subordinates true or false
Example
{
    "pageSize": 65535,
    "pageIndex": 1,
    "customerId": "1966023393642045440",
    "subsumption": false
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "pageSize": 65535,
   "pageIndex": 1,
   "customerId": "1966023393642045440",
   "subsumption": false
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/page", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(PageResult«ApiDeviceInfoVO»)
PageResult«ApiDeviceInfoVO»
optional
records
array[object (ApiDeviceInfoVO)]  | 
null 
optional
total
integer  | 
null 
optional
size
integer  | 
null 
optional
current
integer  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "records": [
      {
        "id": "",
        "customerName": "",
        "deviceName": "",
        "deviceType": "",
        "camCount": 0,
        "timezone": "",
        "activeTime": "",
        "expirationTime": "",
        "iccid": "",
        "tripType": "",
        "tripValue": "",
        "createTime": ""
      }
    ],
    "total": 0,
    "size": 0,
    "current": 0
  },
  "msg": ""
}

deviceTypes
POST
/v2/openapi/device/types
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
object
 
Example
{}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/types", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[string] | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    ""
  ],
  "msg": ""
}
Modified at 2 days ago
Previous
devicePage
Next
deviceTypeInfo


deviceTypeInfo
POST
/v2/openapi/device/type/info
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceType
string  | 
null 
required
Example
{
    "deviceType": "MC202L"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceType": "MC202L"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/type/info", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(ApiDeviceTypeVO)
ApiDeviceTypeVO
optional
typeName
string  | 
null 
optional
typeCode
string  | 
null 
optional
typeVersion
string  | 
null 
optional
tripType
string  | 
null 
optional
accType
integer  | 
null 
optional
1 support 0 not support
chargeType
integer  | 
null 
optional
1 support 0 not support
extendType
integer  | 
null 
optional
1 support 0 not support
extendCount
integer  | 
null 
optional
Maximum number of peripherals
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "typeName": "",
    "typeCode": "",
    "typeVersion": "",
    "tripType": "",
    "accType": 0,
    "chargeType": 0,
    "extendType": 0,
    "extendCount": 0
  },
  "msg": ""
}

deviceDataByDeviceIds
POST
/v2/openapi/device/shadow/deviceIds
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceIds
string  | 
null 
required
Multiple devices should be separated by a comma
Example
{
    "deviceIds": "240070417261"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceIds": "240070417261"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/shadow/deviceIds", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiDeviceShadowVO)]  | 
null 
optional
deviceData
object 
(ApiDeviceDataVO)
ApiDeviceDataVO
optional
device Properties
expand
object 
(ApiDeviceExpandVO)
ApiDeviceExpandVO
optional
extended attribute
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "deviceData": {
        "deviceName": "",
        "deviceId": "",
        "deviceTime": "",
        "address": "",
        "speed": 0.0,
        "course": 0,
        "acc": 0,
        "lat": 0.0,
        "lon": 0.0,
        "num": 0,
        "signal": 0,
        "quantity": 0,
        "voltage": 0.0,
        "elec": 0,
        "type": 0,
        "voltageLevel": 0,
        "rssi": 0,
        "disarmingStatus": 0,
        "chargeStatus": 0,
        "blockedStatus": 0,
        "odometer": 0.0,
        "accUpdateTime": ""
      },
      "expand": {
        "status": false,
        "activeTime": "",
        "reportTime": ""
      }
    }
  ],
  "msg": ""
}



deviceDataByCustomerId
POST
/v2/openapi/device/shadow/customer
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
customerId
string  | 
null 
required
Example
{
    "customerId": "1966023393642045440"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "customerId": "1966023393642045440"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/shadow/customer", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiDeviceShadowVO)]  | 
null 
optional
deviceData
object 
(ApiDeviceDataVO)
ApiDeviceDataVO
optional
device Properties
expand
object 
(ApiDeviceExpandVO)
ApiDeviceExpandVO
optional
extended attribute
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "deviceData": {
        "deviceName": "",
        "deviceId": "",
        "deviceTime": "",
        "address": "",
        "speed": 0.0,
        "course": 0,
        "acc": 0,
        "lat": 0.0,
        "lon": 0.0,
        "num": 0,
        "signal": 0,
        "quantity": 0,
        "voltage": 0.0,
        "elec": 0,
        "type": 0,
        "voltageLevel": 0,
        "rssi": 0,
        "disarmingStatus": 0,
        "chargeStatus": 0,
        "blockedStatus": 0,
        "odometer": 0.0,
        "accUpdateTime": ""
      },
      "expand": {
        "status": false,
        "activeTime": "",
        "reportTime": ""
      }
    }
  ],
  "msg": ""
}
Modified at 2 days ago



deviceTripInfoByTripId
POST
/v2/openapi/device/gpsTripData
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
tripId
string  | 
null 
required
Example
{
    "tripId": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "tripId": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/gpsTripData", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiDeviceTripDataVO)]  | 
null 
optional
reportTime
string  | 
null 
optional
yyyy-MM-dd HH:mm:ss UTF-0
speed
string  | 
null 
optional
speed
course
string  | 
null 
optional
course
acc
string  | 
null 
optional
0：off，1：on
lat
number  | 
null 
optional
lat
lon
number  | 
null 
optional
lon
num
integer  | 
null 
optional
number of satellites
signal
integer  | 
null 
optional
signal
type
integer  | 
null 
optional
1 gps 2 lbs 3 wifi
actual
boolean  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "reportTime": "",
      "speed": "",
      "course": "",
      "acc": "",
      "lat": 0.0,
      "lon": 0.0,
      "num": 0,
      "signal": 0,
      "type": 0,
      "actual": false
    }
  ],
  "msg": ""
}


deviceTripsByDeviceId
POST
/v2/openapi/device/gpsTrip
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
start
string  | 
null 
required
UTC = 0 yyyy-MM-dd HH:mm:ss
end
string  | 
null 
required
UTC = 0 yyyy-MM-dd HH:mm:ss
type
string  | 
null 
optional
1 gps 2lbs 3wifi
Can be used multiple times, separated can be empty, default all if not passed
Example
{
    "deviceId": "string",
    "start": "string",
    "end": "string",
    "type": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "string",
   "start": "string",
   "end": "string",
   "type": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/gpsTrip", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(ApiDeviceGpsTripVO)
ApiDeviceGpsTripVO
optional
totalMileage
number  | 
null 
optional
totalTime
integer  | 
null 
optional
avgSpeed
number  | 
null 
optional
maxSpeed
number  | 
null 
optional
deviceData
array[object (ApiDeviceTripVO)]  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "totalMileage": 0.0,
    "totalTime": 0,
    "avgSpeed": 0.0,
    "maxSpeed": 0.0,
    "deviceData": [
      {
        "tripId": "",
        "deviceId": "",
        "startTime": "",
        "startLat": 0.0,
        "startLon": 0.0,
        "pointType": "",
        "endTime": "",
        "endLat": 0.0,
        "endLon": 0.0,
        "totalTime": 0,
        "totalMileage": 0.0,
        "avgSpeed": 0.0,
        "maxSpeed": 0.0
      }
    ]
  },
  "msg": ""
}
Modified at about 1 month ago


deviceTraffic
POST
/v2/openapi/device/traffic/page
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
pageSize
integer  | 
null 
optional
pageSize,default 100,can't change
Default:
100
pageIndex
integer  | 
null 
required
Default:
1
queryType
string  | 
null 
optional
Query type (default is Device)
Customer: Customer
Device: Device
Only one of either customer or device can be selected.
When selecting a device, at least one device must be selected. The existing logic for other devices remains unchanged. This query can be performed across multiple customers (up to 100 devices).
When selecting a customer, only one customer can be selected at a time. This is mandatory. Only all devices belonging to the specified customer will be queried, excluding those belonging to subordinates (up to 100 devices can be selected).
Default:
Device
customerId
string  | 
null 
optional
customerId
deviceIds
string  | 
null 
optional
deviceIds ,Multiple devices should be separated by a comma
startDate
string  | 
null 
required
Start date, format: YYYY-MM-DD
endDate
string  | 
null 
required
End date, format: YYYY-MM-DD
Example
{
    "pageSize": "100",
    "pageIndex": "1",
    "queryType": "Device",
    "customerId": "string",
    "deviceIds": "string",
    "startDate": "string",
    "endDate": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "pageSize": "100",
   "pageIndex": "1",
   "queryType": "Device",
   "customerId": "string",
   "deviceIds": "string",
   "startDate": "string",
   "endDate": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/traffic/page", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(PageResult«ApiTrafficReportVO»)
PageResult«ApiTrafficReportVO»
optional
records
array[object (ApiTrafficReportVO)]  | 
null 
optional
total
integer  | 
null 
optional
size
integer  | 
null 
optional
current
integer  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "records": [
      {
        "deviceId": "",
        "deviceName": "",
        "trafficSize": 0
      }
    ],
    "total": 0,
    "size": 0,
    "current": 0
  },
  "msg": ""
}
Modified at about 1 month ago
Previous
deviceTripsByDeviceId
Next
deviceSensorData


deviceSensorData
POST
/v2/openapi/device/sensor
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
Example
{
    "deviceId": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/sensor", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiDeviceSensorDataVO)]  | 
null 
optional
peripheralId
integer  | 
null 
optional
Peripheral wiring number
itemCode
string  | 
null 
optional
fuelQuantity ：Remaining fuel quantity, 2 decimal places
itemValue
string  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "peripheralId": 0,
      "itemCode": "",
      "itemValue": ""
    }
  ],
  "msg": ""
}
Modified at about 1 month ago


expandInfoByDeviceId
POST
/v2/openapi/device/expand/info
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
Example
{
    "deviceId": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/expand/info", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(ApiDeviceExpandConfigVO)
ApiDeviceExpandConfigVO
optional
id
string  | 
null 
optional
device ID
channelName
string  | 
null 
optional
channel Name
"[{"id":1,"name":"CH1"},{"id":2,"name":"CH2"},{"id":3,"name":"CH3"},{"id":4,"name":"CH4"}]"
Channel 1, channel 2, channel 3, channel 4 are denoted respectively
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "id": "",
    "channelName": ""
  },
  "msg": ""
}

saveDeviceChannelName
POST
/v2/openapi/device/channel/name/save
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
channelName
string  | 
null 
optional
You need to enter a JSON format, where id indicates the channel number and name indicates the channel name
reference:[{"id":1,"name":"CH1"},{"id":2,"name":"CH2"}]
Example
{
    "deviceId": "string",
    "channelName": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "string",
   "channelName": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/device/channel/name/save", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {},
  "msg": ""
}
Modified at about 1 month ago
Previous
expandInfoByDeviceId
Next
fencePage



history

---

## Historical Video Upload Flow

This flow describes how historical video files are retrieved from a device, uploaded, and managed through task-based operations.

### 1. Retrieve Playback Records (`playBackList`)

The process starts by querying the device for historical video records.

* Each record may include a `fileURL`.
* If `fileURL` is `null`, it means the video file has not yet been uploaded and is still stored on the device.

### 2. Enable Historical Upload (`historicalUpload`)

For records without a `fileURL`, the device is instructed to upload historical videos.

* This step enables upload functionality on the device.
* Upload tasks are generated for each eligible video file.

### 3. Monitor Upload Progress (`taskPage`)

Once upload tasks are created, their progress is monitored.

* This step is used to check the status and completion percentage of each upload task.
* Tasks remain in progress until they either complete, are stopped, or are deleted.

### 4. Task Completion (`Complete`)

When a device successfully uploads a complete video file:

* The task status changes to **Complete**.
* A valid `fileURL` is generated.
* The video can now be retrieved or queried in subsequent playback requests.

### 5. Stop Upload Task (`taskStop`)

If necessary, unfinished upload tasks can be stopped.

* This is typically used to halt uploads that are no longer required or need to be paused.

### 6. Delete Upload Task (`taskDelete`)

Upload tasks can be permanently removed.

* This cleans up task records and should be used after completion or when tasks are no longer needed.

---


playBackList
POST
/v2/openapi/video/history/list
fileUrl is empty, indicating that no historical videos have been uploaded. You can upload device history videos through "/v2/openapp/video/history/upload". You can view all upload records through "/v2/openapi/video/history/upload/task".

Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
>= 1
startTime
string  | 
null 
required
startTime Device Time Zone yyyy-MM-dd HH:mm:ss
endTime
string  | 
null 
required
endTime Device Time Zone yyyy-MM-dd HH:mm:ss
Example
{
  "deviceId": "240070417261",
  "channelId": 1,
  "startTime": "2025-12-11 00:00:00",
  "endTime": "2025-12-11 23:59:59"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "240070417261",
   "channelId": 1,
   "startTime": "2025-12-11 00:00:00",
   "endTime": "2025-12-11 23:59:59"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/list", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
array[object (ApiVideoHistoryVO)]  | 
null 
optional
deviceName
string  | 
null 
optional
deviceName
channelId
integer  | 
null 
optional
channelId
fileSize
number  | 
null 
optional
fileSize unit(MB)
startTime
string  | 
null 
optional
startTime yyyy-MM-dd HH:mm:ss Device Time Zone
endTime
string  | 
null 
optional
endTime yyyy-MM-dd HH:mm:ss Device Time Zone
fileUrl
string  | 
null 
optional
file download path
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": [
    {
      "deviceName": "",
      "channelId": 0,
      "fileSize": 0.0,
      "startTime": "",
      "endTime": "",
      "fileUrl": ""
    }
  ],
  "msg": ""
}


historicalUpload
POST
/v2/openapi/video/history/upload
The access time interval for interfaces with the same parameters is 10 seconds.

response: data : taskId

Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
>= 1
startTime
string  | 
null 
required
Download file start time Device Time Zone yyyy-MM-dd HH:mm:ss
endTime
string  | 
null 
required
Download file end time Device Time Zone yyyy-MM-dd HH:mm:ss
fileSize
number  | 
null 
optional
File size in MB units
1.7MB per second estimated
Example
{
    "deviceId": "string",
    "channelId": 1,
    "startTime": "string",
    "endTime": "string",
    "fileSize": 0
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "string",
   "channelId": 1,
   "startTime": "string",
   "endTime": "string",
   "fileSize": 0
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/upload", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
taskID
code
integer  | 
null 
optional
data
string  | 
null 
optional
taskId
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": "",
  "msg": ""
}


playBack
POST
/v2/openapi/video/history/replay
9.26 Added parameter nodeValue, optional replay streaming node
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
>= 1
playbackType
integer  | 
null 
required
playbackType 0：Normal ；1：Fast ；2：PlayBack；3：KeyFrame ；4：SingleFrame
fastForwardOrBackward
integer  | 
null 
required
fastForwardOrBackward 0：invalid； 1：1x； 2：2x 3：4x； 4：8x； 5：16x
startTime
string  | 
null 
required
startTime Device Time Zone yyyy-MM-dd HH:mm:ss
endTime
string  | 
null 
required
endTime Device Time Zone yyyy-MM-dd HH:mm:ss
nodeValue
string  | 
null 
optional
The name of the stream used to select the replay, or the default one if it is not passed The value of this parameter can be obtained through the /v2/audio/nodes interface
Example
{
    "deviceId": "806070467859",
    "channelId": 1,
    "playbackType": 0,
    "fastForwardOrBackward": 1,
    "startTime": "2025-12-11 08:47:20",
    "endTime": "2025-12-11 08:55:09",
    "nodeValue": "sit-1"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "806070467859",
   "channelId": 1,
   "playbackType": 0,
   "fastForwardOrBackward": 1,
   "startTime": "2025-12-11 08:47:20",
   "endTime": "2025-12-11 08:55:09",
   "nodeValue": "sit-1"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/replay", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
string  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": "",
  "msg": ""
}
Modified at 2 days ago


eplaySet
POST
/v2/openapi/video/history/replaySet
remove nodeValue, remove dragTime
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
deviceId
string  | 
null 
required
deviceId
channelId
integer  | 
null 
required
channelId
>= 1
playbackControl
integer  | 
null 
required
playbackControl
0：Start；
2：End；
3：Fast；
4：Keyframe rewind playback；
fastForwardOrBackward
integer  | 
null 
required
When playbackControl is 3 and 4, the content of this field is valid; otherwise, it is set to
Fast forward or rewind 0：invalid； 1：1x； 2：2x 3：4x； 4：8x； 5：16x
Example
{
    "deviceId": "806070467859",
    "channelId": 1,
    "playbackControl": 2,
    "fastForwardOrBackward": 1
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "deviceId": "806070467859",
   "channelId": 1,
   "playbackControl": 2,
   "fastForwardOrBackward": 1
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/replaySet", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {},
  "msg": ""
}
Modified at 2 days ago
Previous
playBack
Next
taskPage


taskPage
POST
/v2/openapi/video/history/upload/task
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
pageSize
integer  | 
null 
optional
Default:
10
pageIndex
integer  | 
null 
optional
Default:
1
deviceIds
string  | 
null 
optional
deviceIds split by ,
status
integer  | 
null 
optional
0 failed 1 success 2 uploading 3 pending reply
startTime
string  | 
null 
optional
startTime yyyy-MM-dd HH:mm:ss Device Time Zone
The query interval must be less than 30 days
endTime
string  | 
null 
optional
endTime yyyy-MM-dd HH:mm:ss Device Time Zone
The query interval must be less than 30 days
fileStartTime
string  | 
null 
optional
Video file start time-start time
yyyy-MM-dd HH:mm:ss Device Time Zone
The query interval must be less than 30 days
fileEndTime
string  | 
null 
optional
Video file start time - end time
yyyy-MM-dd HH:mm:ss Device Time Zone
The query interval must be less than 30 days
taskId
string  | 
null 
optional
taskId
Example
{
    "pageSize": "10",
    "pageIndex": "1",
    "deviceIds": "string",
    "status": 0,
    "startTime": "string",
    "endTime": "string",
    "fileStartTime": "string",
    "fileEndTime": "string",
    "taskId": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "pageSize": "10",
   "pageIndex": "1",
   "deviceIds": "string",
   "status": 0,
   "startTime": "string",
   "endTime": "string",
   "fileStartTime": "string",
   "fileEndTime": "string",
   "taskId": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/upload/task", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
object 
(PageResult«ApiVideoHistoryFileVO»)
PageResult«ApiVideoHistoryFileVO»
optional
records
array[object (ApiVideoHistoryFileVO)]  | 
null 
optional
total
integer  | 
null 
optional
size
integer  | 
null 
optional
current
integer  | 
null 
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {
    "records": [
      {
        "id": "",
        "deviceId": "",
        "channelId": 0,
        "status": 0,
        "fileUrl": "",
        "fileStartTime": "",
        "fileEndTime": "",
        "fileSize": 0.0,
        "fileUploadSize": 0.0,
        "createTime": "",
        "uploadTime": ""
      }
    ],
    "total": 0,
    "size": 0,
    "current": 0
  },
  "msg": ""
}

taskStop
POST
/v2/openapi/video/history/upload/stop
Stop the specified historical video upload task
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
uploadId
string  | 
null 
required
Task id
The id in the data returned by the /history/upload/task interface
Example
{
    "uploadId": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "uploadId": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/upload/stop", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
通用返回
code
integer  | 
null 
optional
data
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {},
  "msg": ""
}

taskDelete
POST
/v2/openapi/video/history/task/delete
The task of uploading historical video files will be automatically deleted within 7 days.
You can also directly delete the corresponding tasks and file storage through this API.
Request
Authorization
Add parameter in header Authorization
Example:
Authorization: ********************
Header Params
Authorization
string 
optional
Default:
{{token}}
Body Params
application/json
id
string  | 
null 
required
id
Example
{
    "id": "string"
}
Request Code Samples
Fetch
Axios
jQuery
XHR
Native
Request
Unirest
var myHeaders = new Headers();
myHeaders.append("Authorization", "<api-key>");
myHeaders.append("Content-Type", "application/json");

var raw = JSON.stringify({
   "id": "string"
});

var requestOptions = {
   method: 'POST',
   headers: myHeaders,
   body: raw,
   redirect: 'follow'
};

fetch("https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/task/delete", requestOptions)
   .then(response => response.text())
   .then(result => console.log(result))
   .catch(error => console.log('error', error));
Responses
🟢200
Success
application/json
code
integer  | 
null 
optional
data
optional
msg
string  | 
null 
optional
Example
{
  "code": 0,
  "data": {},
  "msg": ""
}