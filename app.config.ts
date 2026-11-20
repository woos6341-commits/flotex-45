// Load environment variables with proper priority (system > .env)
import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";
// Use an application identifier controlled by the owner of the independent app.
const bundleId = (process.env.EXPO_PUBLIC_ANDROID_PACKAGE || "com.flotex.egp").toLowerCase();
const env = {
  appName: "Flotex EGP",
  appSlug: "flotex-egp",
  scheme: "flotexegp",
  iosBundleId: bundleId,
  androidPackage: bundleId,
};

// Expo serializes this browser-safe subset into native and web bundles. The server-only
// Backend-only secrets must never be exposed in this public runtime object.
const apiBaseUrl = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").trim();
const publicRuntime = {
  oauthPortalUrl: process.env.EXPO_PUBLIC_OAUTH_PORTAL_URL ?? "",
  oauthServerUrl: process.env.EXPO_PUBLIC_OAUTH_SERVER_URL ?? "",
  appId: process.env.EXPO_PUBLIC_APP_ID ?? "",
  apiBaseUrl,
};

const config: ExpoConfig = {
  name: env.appName,
  slug: env.appSlug,
  version: "1.0.0",
  extra: publicRuntime,
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    "infoPlist": {
        "ITSAppUsesNonExemptEncryption": false
      }
  },
  android: {
    // Resize keeps the focused TextInput visible while the Android IME opens.
    // Pan can move the root view during controlled-input updates and cause native focus loss.
    softwareKeyboardLayoutMode: "resize",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    package: env.androidPackage,
    permissions: ["POST_NOTIFICATIONS", "REQUEST_INSTALL_PACKAGES"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: env.scheme,
            host: "*",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-asset",
    "expo-router",
    ["expo-media-library", { photosPermission: "نستخدم معرض الصور لحفظ نسخة الفاتورة التي ينشئها المدير." }],
    [
      "expo-image-picker",
      {
        cameraPermission: "نستخدم الكاميرا لالتقاط صورة السيلفي المطلوبة لتوثيق الحساب.",
        photosPermission: "نستخدم الصور لاختيار صور الهوية ولقطة صفحة الملف الشخصي بالمحفظة الإلكترونية.",
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone.",
      },
    ],
    [
      "expo-video",
      {
        supportsBackgroundPlayback: true,
        supportsPictureInPicture: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: {
          backgroundColor: "#000000",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
          minSdkVersion: 24,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
