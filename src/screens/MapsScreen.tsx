import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  ListCard,
  PageHeader,
  Screen,
  SectionLabel,
  spacing,
  useEdgePadding,
  CONTENT_MAX_WIDTH,
} from '../ui/components';
import { useAndroidBack } from '../ui/use-android-back';
import { RouteMapScreen } from '../maps/RouteMapScreen';
import { DepotMapScreen } from '../maps/DepotMapScreen';

type Surface = 'menu' | 'route' | 'depot';

export function MapsScreen({
  onOpenStop,
  onBack,
}: {
  onOpenStop: (stopId: string) => void;
  onBack: () => void;
}) {
  const edge = useEdgePadding();
  const [surface, setSurface] = useState<Surface>('menu');

  useAndroidBack(
    useCallback(() => {
      if (surface === 'menu') return false;
      setSurface('menu');
      return true;
    }, [surface]),
  );

  if (surface === 'route') {
    return <RouteMapScreen onOpenStop={onOpenStop} onBack={() => setSurface('menu')} />;
  }
  if (surface === 'depot') {
    return <DepotMapScreen onOpenStop={onOpenStop} onBack={() => setSurface('menu')} />;
  }

  return (
    <Screen>
      <PageHeader title="Maps" subtitle="Two views of the same day" onBack={onBack} />

      <View style={[styles.content, edge]}>
        <SectionLabel>Choose a view</SectionLabel>

        <ListCard
          icon="navigation"
          title="My route"
          subtitle="Your stops and live position. Tap a pin to open the stop."
          onPress={() => setSurface('route')}
        />

        <ListCard
          icon="grid"
          title="Depot overview"
          subtitle="Every stop in the coverage area, filterable by status."
          onPress={() => setSurface('depot')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.md,
    gap: spacing.sm,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
});
