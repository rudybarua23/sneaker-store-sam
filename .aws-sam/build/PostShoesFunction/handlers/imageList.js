const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const REGION = "us-east-1";
const BUCKET_NAME = "sneakersbucket-publicfiles";
const FOLDER_PREFIX = "images/";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json"
};

const s3 = new S3Client({ region: REGION });

exports.handler = async () => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: FOLDER_PREFIX,
    });

    const response = await s3.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS, 
        body: JSON.stringify({ message: "No images found." }),
      };
    }

    const imageUrls = response.Contents
      .filter(obj => !obj.Key.endsWith("/")) // Exclude the folder itself
      .map(obj => `https://${BUCKET_NAME}.s3.amazonaws.com/${obj.Key}`);

    return {
      statusCode: 200,
      headers: CORS_HEADERS, 
      body: JSON.stringify({ images: imageUrls }),
    };
  } catch (error) {
    console.error("Error listing images:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS, 
      body: JSON.stringify({ message: "Error listing images", error: error.message }),
    };
  }
};

