import React, { useState, useEffect } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable, ScrollView, Linking, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';

// Add verified products to catalog.json. Do not guess which codes belong to which doll.
const CATALOG = require('./catalog.json');

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [code, setCode] = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const [torch, setTorch] = useState(false);

  const normalized = (value) => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const match = code ? CATALOG.find(p =>
    (p.codes || []).some(c => normalized(c.value) === normalized(code))
  ) : null;

  const handleScan = ({ data }) => {
    if (!data || normalized(data) === normalized(lastScanned)) return;
    setLastScanned(data);
    setCode(String(data));
    setManualCode(String(data));
    setScanning(false);
  };

  const searchUrl = code
    ? 'https://www.google.com/search?q=' + encodeURIComponent('"'+code+'" Monster High doll Mattel')
    : 'https://www.google.com/search?q=' + encodeURIComponent('Monster High dolls Mattel product catalog');

  const open = async (url) => { try { await Linking.openURL(url); } catch (e) {} };

  if (!permission) {
    return <SafeAreaView style={styles.container}><Text style={styles.body}>Preparing camera permission…</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.kicker}>COLLECTOR TOOL</Text>
        <Text style={styles.title}>MONSTER HIGH{"\n"}SCANNER</Text>
        <Text style={styles.subtitle}>Scan a box. Find the ghoul.</Text>

        {scanning ? (
          <View style={styles.cameraWrap}>
            {permission.granted ? (
              <CameraView style={styles.camera} facing="back" enableTorch={torch}
                barcodeScannerSettings={{ barcodeTypes: ['ean13','ean8','upc_a','upc_e','code128','code39','qr','itf'] }}
                onBarcodeScanned={handleScan} />
            ) : (
              <View style={styles.permissionBox}>
                <Text style={styles.body}>Camera access is needed to scan box barcodes.</Text>
                <Pressable style={styles.button} onPress={requestPermission}><Text style={styles.buttonText}>ALLOW CAMERA</Text></Pressable>
              </View>
            )}
            <View style={styles.cameraControls}>
              <Pressable style={styles.smallButton} onPress={() => setTorch(!torch)}><Text style={styles.buttonText}>{torch ? 'TORCH ON' : 'TORCH OFF'}</Text></Pressable>
              <Pressable style={styles.smallButton} onPress={() => setScanning(false)}><Text style={styles.buttonText}>CLOSE SCANNER</Text></Pressable>
            </View>
          </View>
        ) : (
          <Pressable style={styles.scanButton} onPress={async () => {
            if (!permission.granted) { const result = await requestPermission(); if (!result.granted) return; }
            setLastScanned('');
            setScanning(true);
          }}>
            <Text style={styles.scanIcon}>▦</Text>
            <Text style={styles.scanButtonTitle}>SCAN BARCODE</Text>
            <Text style={styles.scanButtonSub}>Use your camera</Text>
          </Pressable>
        )}

        <Text style={styles.section}>OR ENTER A CODE</Text>
        <View style={styles.inputRow}>
          <TextInput value={manualCode} onChangeText={setManualCode} placeholder="UPC, Mattel code, or printed number"
            placeholderTextColor="#aaa3b7" autoCapitalize="characters" style={styles.input} returnKeyType="search"
            onSubmitEditing={() => { setCode(manualCode.trim()); setScanning(false); }} />
          <Pressable style={styles.goButton} onPress={() => { setCode(manualCode.trim()); setScanning(false); }}><Text style={styles.buttonText}>FIND</Text></Pressable>
        </View>

        {code ? (
          <View style={styles.resultCard}>
            <Text style={styles.section}>LOOKUP RESULT</Text>
            <Text style={styles.code}>{code}</Text>
            {match ? (
              <>
                <Text style={styles.productName}>{match.name}</Text>
                {!!match.character && <Text style={styles.body}>Character: {match.character}</Text>}
                {!!match.series && <Text style={styles.body}>Series: {match.series}</Text>}
                {!!match.mattelCode && <Text style={styles.body}>Mattel code: {match.mattelCode}</Text>}
                <Text style={styles.verified}>CATALOG MATCH</Text>
                {!!match.officialUrl && <Pressable style={styles.button} onPress={() => open(match.officialUrl)}><Text style={styles.buttonText}>OPEN OFFICIAL MATTEL PAGE ↗</Text></Pressable>}
                {!!match.referenceUrl && <Pressable style={styles.outlineButton} onPress={() => open(match.referenceUrl)}><Text style={styles.buttonText}>OPEN REFERENCE ↗</Text></Pressable>}
              </>
            ) : (
              <>
                <Text style={styles.productName}>No verified match yet</Text>
                <Text style={styles.body}>The code was captured, but it isn't in the local catalog. Search online to help identify it.</Text>
                <Pressable style={styles.button} onPress={() => open(searchUrl)}><Text style={styles.buttonText}>SEARCH THIS CODE ONLINE ↗</Text></Pressable>
                <Pressable style={styles.outlineButton} onPress={() => open('https://service.mattel.com/')}><Text style={styles.buttonText}>MATTEL PRODUCT SUPPORT ↗</Text></Pressable>
              </>
            )}
            <Pressable style={styles.textButton} onPress={() => { setCode(''); setManualCode(''); setLastScanned(''); }}><Text style={styles.textButtonText}>CLEAR RESULT</Text></Pressable>
          </View>
        ) : (
          <View style={styles.infoCard}>
            <Text style={styles.productName}>Ready when you are.</Text>
            <Text style={styles.body}>Barcode scanning works on-device. Printed-number OCR and a larger verified catalog are planned next; for now, enter printed numbers manually.</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Pressable onPress={() => open('https://creations.mattel.com/collections/monster-high')}><Text style={styles.link}>OFFICIAL MONSTER HIGH ↗</Text></Pressable>
          <Text style={styles.footerText}>Offline matching for codes in the bundled catalog. Internet is needed for web searches.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:{flex:1,backgroundColor:'#160f21'},
  content:{padding:20,paddingBottom:40},
  kicker:{color:'#f3a6ec',fontSize:11,fontWeight:'900',letterSpacing:3,marginTop:10},
  title:{color:'#fff',fontSize:36,fontWeight:'900',letterSpacing:1,marginTop:8,lineHeight:39},
  subtitle:{color:'#d7c6df',fontSize:15,marginTop:8,marginBottom:22},
  scanButton:{backgroundColor:'#a92d8f',borderRadius:18,padding:22,alignItems:'center',marginBottom:22},
  scanIcon:{color:'#fff',fontSize:40,fontWeight:'800'},
  scanButtonTitle:{color:'#fff',fontSize:18,fontWeight:'900',letterSpacing:1,marginTop:4},
  scanButtonSub:{color:'#f8dff5',fontSize:13,marginTop:4},
  section:{color:'#e9a7df',fontSize:11,fontWeight:'900',letterSpacing:2,marginBottom:10,marginTop:8},
  inputRow:{flexDirection:'row',gap:8,marginBottom:18},
  input:{flex:1,minHeight:50,borderWidth:1,borderColor:'#57425f',borderRadius:12,paddingHorizontal:12,color:'#fff',fontSize:14,backgroundColor:'#24172f'},
  goButton:{backgroundColor:'#6d3e87',borderRadius:12,paddingHorizontal:17,justifyContent:'center'},
  button:{backgroundColor:'#a92d8f',borderRadius:11,padding:14,alignItems:'center',marginTop:12},
  outlineButton:{borderWidth:1,borderColor:'#b77bc4',borderRadius:11,padding:13,alignItems:'center',marginTop:9},
  buttonText:{color:'#fff',fontWeight:'900',fontSize:12,letterSpacing:.5},
  infoCard:{backgroundColor:'#24172f',borderRadius:16,padding:18,borderWidth:1,borderColor:'#493153',marginTop:4},
  resultCard:{backgroundColor:'#24172f',borderRadius:16,padding:18,borderWidth:1,borderColor:'#8a3c83',marginTop:4},
  productName:{color:'#fff',fontSize:18,fontWeight:'800',marginBottom:7},
  body:{color:'#d6cadc',fontSize:14,lineHeight:21,marginTop:4},
  code:{color:'#f3a6ec',fontSize:22,fontWeight:'900',marginBottom:12},
  verified:{color:'#91e8b2',fontSize:11,fontWeight:'900',letterSpacing:1,marginTop:10},
  textButton:{alignItems:'center',padding:14,marginTop:5},
  textButtonText:{color:'#f3a6ec',fontSize:12,fontWeight:'800'},
  cameraWrap:{height:390,borderRadius:16,overflow:'hidden',marginBottom:20,backgroundColor:'#08060b'},
  camera:{flex:1},
  cameraControls:{position:'absolute',bottom:12,left:12,right:12,flexDirection:'row',justifyContent:'space-between'},
  smallButton:{backgroundColor:'#2b1c36dd',padding:12,borderRadius:10},
  permissionBox:{flex:1,justifyContent:'center',alignItems:'center',padding:20},
  footer:{alignItems:'center',marginTop:25,gap:10},
  link:{color:'#f3a6ec',fontWeight:'900',letterSpacing:1,fontSize:12},
  footerText:{color:'#8f819a',fontSize:11,textAlign:'center',lineHeight:16}
});
